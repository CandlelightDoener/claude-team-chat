const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

// --- Config ---
const CONFIG_PATH = path.join(__dirname, 'config.json');

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    console.error('\n  ❌ Keine config.json gefunden!');
    console.error('  Starte "claude" in diesem Ordner, um das Setup durchzuführen.\n');
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
}

const config = loadConfig();
const PORT = config.port || 3333;
const ROOT = path.resolve(__dirname, config.root || '..');
const FEEDBACK_URL = config.feedbackUrl || '';
const CONTEXT_FILE = config.contextFile || '';

// Build AGENTS from config
const AGENTS = { ...config.agents };
// Add coach
const coachConfig = config.coach || { id: 'coach', name: 'Coach', role: 'Moderator', dir: '.', color: '#A78BFA' };
AGENTS[coachConfig.id || 'coach'] = {
  name: coachConfig.name,
  role: coachConfig.role,
  dir: coachConfig.dir || '.',
  color: coachConfig.color || '#A78BFA',
  avatar: coachConfig.avatar || null,
};
const COACH_ID = coachConfig.id || 'coach';
const COACH_DIR = coachConfig.dir || '.';

const TEAMS = config.teams || [{ id: 'default', name: 'Team', members: Object.keys(config.agents) }];

// Build name→id lookup
const NAME_TO_ID = {};
for (const [id, a] of Object.entries(AGENTS)) {
  NAME_TO_ID[a.name.toLowerCase()] = id;
  NAME_TO_ID[a.name.split(' ')[0].toLowerCase()] = id;
  NAME_TO_ID[id] = id;
}

// --- Reactions ---
const ACK_REACTIONS = [
  { emoji: '👍', comments: ["gute Idee", "bin dafür", "sehe ich auch so", "passt perfekt"] },
  { emoji: '🔥', comments: ["mega", "stark", "genau das", "ja bitte!"] },
  { emoji: '💡', comments: ["spannender Ansatz", "da geht was", "darauf kann ich aufbauen"] },
  { emoji: '✅', comments: ["erledige ich", "mach ich", "übernehm ich"] },
  { emoji: '👀', comments: ["muss ich mir angucken", "will ich besser verstehen", "hm, schauen wir mal"] },
  { emoji: '🙌', comments: ["bin dabei", "genau mein Ding", "da bin ich sofort dran"] },
  { emoji: '🤔', comments: ["bin nicht sicher", "müssten wir nochmal drüber reden", "sehe ich anders"] },
  { emoji: '⚡', comments: ["das wäre ein Quick Win", "können wir sofort machen", "low hanging fruit"] },
  { emoji: '🎯', comments: ["trifft den Punkt", "genau das Richtige", "spot on"] },
  { emoji: '❌', comments: ["dagegen", "halte ich für riskant", "würde ich nicht machen", "lieber nicht"] },
];

function randomReaction() {
  const r = ACK_REACTIONS[Math.floor(Math.random() * ACK_REACTIONS.length)];
  return { emoji: r.emoji, comment: r.comments[Math.floor(Math.random() * r.comments.length)] };
}

function pickReactingAgents(text, agents) {
  // Relevanz: Agent wird erwähnt (Name/Rolle/Keywords) → reagiert immer
  // Rest: zufällig 1-2 aus den übrigen
  const textLower = text.toLowerCase();
  const mentioned = [];
  const rest = [];

  for (const id of agents) {
    const a = AGENTS[id];
    if (!a) continue;
    const nameMatch = textLower.includes(a.name.split(' ')[0].toLowerCase());
    const roleWords = a.role.toLowerCase().split(/[\s,&/]+/);
    const roleMatch = roleWords.some(w => w.length > 3 && textLower.includes(w));
    if (nameMatch || roleMatch) {
      mentioned.push(id);
    } else {
      rest.push(id);
    }
  }

  // Shuffle rest, pick 1-2
  for (let i = rest.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [rest[i], rest[j]] = [rest[j], rest[i]];
  }
  const extraCount = Math.min(rest.length, mentioned.length > 0 ? 1 : 2);
  return [...mentioned, ...rest.slice(0, extraCount)];
}

// --- State ---
let messages = [];
let sseClients = [];
let isProcessing = false;
let autoMode = false;
let paused = false;
let pendingSebastianMsg = null;
let waitingForSebastian = false;
let activeAgents = config.activeAgents || Object.keys(config.agents);
let lastCoachResponse = '';

// Topic tracking
let currentTopic = null;       // { name, startMsgId }
let completedTopics = [];      // [{ name, startMsgId, endMsgId, summary, actionItems }]

// --- SSE ---
function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  sseClients = sseClients.filter(res => {
    try { res.write(payload); return true; }
    catch { return false; }
  });
}

function addMessage(from, text, role) {
  const msg = {
    id: messages.length,
    from,
    name: from === 'sebastian' ? 'Sebastian' : (AGENTS[from]?.name || from),
    text,
    role: role || from,
    time: new Date().toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }),
    color: from === 'sebastian' ? '#3B82F6' : (AGENTS[from]?.color || '#666'),
    avatar: from === 'sebastian' ? null : (AGENTS[from]?.avatar || null),
  };
  messages.push(msg);
  broadcast('message', msg);
  return msg;
}

// --- Claude CLI ---
function runClaude(cwd, prompt) {
  return new Promise((resolve, reject) => {
    const fullCwd = path.join(ROOT, cwd);
    const proc = spawn('claude', ['-p', prompt], {
      cwd: fullCwd,
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', d => { stdout += d.toString(); });
    proc.stderr.on('data', d => { stderr += d.toString(); });
    proc.on('close', code => {
      if (code !== 0) {
        console.error(`Claude exited ${code} in ${cwd}:`, stderr);
      }
      resolve(stdout.trim());
    });
    proc.on('error', reject);
  });
}

function buildChatMarkdown() {
  const date = new Date().toLocaleDateString('de-DE');
  const participants = [...new Set(messages.map(m => m.name))].join(', ');
  let md = `# Chat — ${date}\n\n**Teilnehmer:** ${participants}\n\n---\n\n`;
  for (const m of messages) {
    md += `**${m.name}** (${m.time}):\n${m.text}\n\n`;
  }
  return md;
}

function buildConversationText() {
  return messages.map(m => `**${m.name}:** ${m.text}`).join('\n\n');
}

// --- Orchestration ---
async function runCoach(instruction) {
  let kontext = '';
  if (CONTEXT_FILE) {
    const kontextPath = path.join(ROOT, CONTEXT_FILE);
    if (fs.existsSync(kontextPath)) kontext = fs.readFileSync(kontextPath, 'utf-8');
  }

  let agentProfiles = '';
  for (const id of activeAgents) {
    const a = AGENTS[id];
    const claudeMd = path.join(ROOT, a.dir, 'CLAUDE.md');
    if (fs.existsSync(claudeMd)) {
      const content = fs.readFileSync(claudeMd, 'utf-8').split('\n').slice(0, 20).join('\n');
      agentProfiles += `\n### ${a.name} (${id})\n${content}\n`;
    }
  }

  const agentNameList = activeAgents.map(id => `- ${AGENTS[id].name} (Direktive: → NEXT: ${id})`).join('\n');

  const topicInfo = currentTopic
    ? `\n## Aktuelles Thema: "${currentTopic.name}"\nDieses Thema läuft seit Nachricht #${currentTopic.startMsgId}. Wenn es ausdiskutiert ist, schließe es mit → WRAP ab und eröffne das nächste.\n`
    : '\nEs läuft noch kein konkretes Thema. Eröffne eines mit → TOPIC.\n';

  const wrappedInfo = completedTopics.length > 0
    ? `\n## Bereits abgeschlossene Themen\n${completedTopics.map(t => `- ✅ ${t.name}`).join('\n')}\n`
    : '';

  const coachName = AGENTS[COACH_ID]?.name || 'Coach';
  const kontextSection = kontext ? `\n## Business-Kontext\n${kontext}\n` : '';

  const prompt = `Du bist ${coachName}, ${AGENTS[COACH_ID]?.role || 'Moderator'}, und moderierst eine Team-Diskussion im WhatsApp-Gruppenchat.
${kontextSection}

## Teilnehmende Agenten — DIESE NAMEN VERWENDEN
${agentNameList}

WICHTIG: Verwende AUSSCHLIESSLICH die oben gelisteten Namen. Keine alten Namen wie "Rina" oder "Hedi".

## Agenten-Profile (Hintergrund)
${agentProfiles}
${topicInfo}${wrappedInfo}
## Bisherige Unterhaltung
${buildConversationText()}

## Deine Aufgabe jetzt
${instruction}

STIL: Du schreibst wie in einem WhatsApp-Gruppenchat — kurz, direkt, freundlich. Keine Formalitäten. Max 150 Wörter.

REGELN:
- Beende NICHT zu früh mit FAZIT. Wenn es offene Abhängigkeiten, ungeklärte Punkte oder Widersprüche zwischen Agenten gibt, bohre nach.
- Stelle sicher, dass JEDER Agent mindestens einmal dran war, bevor du FAZIT in Betracht ziehst.
- Wenn alle Agenten gesprochen haben und keine offenen Punkte mehr da sind, frage Sebastian nach seinem Input (→ SEBASTIAN), bevor du abschließt.
- FAZIT nur wenn Sebastian explizit sagt "reicht" oder wirklich alles geklärt ist.
- THEMEN-MANAGEMENT: Wenn die Diskussion zu einem neuen Thema wechselt, schließe das alte erst ab (WRAP) bevor du das neue eröffnest (TOPIC).
- Wenn ein Thema ausdiskutiert ist und es noch weitere Punkte gibt, mach einen WRAP und dann TOPIC für das nächste.

WICHTIG: Beende deine Antwort mit genau einer Direktive auf der ALLERLETZTEN Zeile:
→ NEXT: <agenten-id> (boris, walli, rina, orlanda)
→ PROBE: <agenten-id> (Nachfrage an einen bestimmten Agenten)
→ TOPIC: <Thema-Name> (Neues Thema eröffnen)
→ WRAP: <Thema-Name> (Aktuelles Thema abschließen — NUR wenn ausdiskutiert)
→ SEBASTIAN (Frage/Rücksprache mit Sebastian)
→ FAZIT (NUR wenn alles geklärt UND Sebastian zugestimmt hat)`;

  return runClaude(COACH_DIR, prompt);
}

async function runAgent(agentId) {
  const a = AGENTS[agentId];
  const teamMembers = activeAgents.map(id => `- ${AGENTS[id].name}`).join('\n');

  const prompt = `Du bist ${a.name} und nimmst an einem WhatsApp-Gruppenchat des sharp sharp AI Teams teil.

## Dein Team
${teamMembers}
- Felix Facilitrix (Agile Coach / Moderator)
- Sebastian (Chef)

## Bisherige Unterhaltung
${buildConversationText()}

## Deine Aufgabe
Lies was zuletzt gesagt wurde und antworte darauf. Sei konkret, bring deine Perspektive ein.

STIL: Du schreibst wie in WhatsApp — kurz, locker, direkt. Keine Formalitäten, kein Corporate-Speak. Emojis sparsam aber natürlich. Max 150 Wörter. Wenn du was nicht weißt, sag das ehrlich.
WICHTIG: Du heißt ${a.name}. Verwende die Teamnamen oben, keine anderen.

Du sprichst als ${a.name}.`;

  return runClaude(a.dir, prompt);
}

function parseDirective(text) {
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    const nextMatch = line.match(/^→\s*NEXT:\s*(.+)$/i);
    if (nextMatch) return { type: 'NEXT', target: resolveAgent(nextMatch[1]) };
    const probeMatch = line.match(/^→\s*PROBE:\s*(.+)$/i);
    if (probeMatch) return { type: 'PROBE', target: resolveAgent(probeMatch[1]) };
    const topicMatch = line.match(/^→\s*TOPIC:\s*(.+)$/i);
    if (topicMatch) return { type: 'TOPIC', name: topicMatch[1].trim() };
    const wrapMatch = line.match(/^→\s*WRAP:\s*(.+)$/i);
    if (wrapMatch) return { type: 'WRAP', name: wrapMatch[1].trim() };
    if (line.includes('FAZIT')) return { type: 'FAZIT' };
    if (line.includes('SEBASTIAN')) return { type: 'SEBASTIAN' };
  }
  return { type: 'UNKNOWN' };
}

function resolveAgent(name) {
  const clean = name.toLowerCase().trim();
  return NAME_TO_ID[clean] || clean;
}

function stripDirective(text) {
  const lines = text.split('\n');
  // Remove last line if it starts with →
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].trim().startsWith('→')) {
      lines.splice(i, 1);
      break;
    }
  }
  return lines.join('\n').trim();
}

async function nextStep() {
  // Zentrale Entscheidung: was passiert als nächstes?
  if (pendingSebastianMsg) {
    pendingSebastianMsg = null;
    waitingForSebastian = false;
    await orchestrate('sebastian');
  } else if (paused) {
    broadcast('status', { processing: false, paused: true });
  } else if (waitingForSebastian && !autoMode) {
    // Coach hat Sebastian gefragt — warten bis er antwortet
    broadcast('status', { processing: false, waitingForSebastian: true });
  } else {
    waitingForSebastian = false;
    await orchestrate('continue');
  }
}

async function generateTopicSummary(topicName, topicMessages) {
  const conversation = topicMessages.map(m => `**${m.name}:** ${m.text}`).join('\n\n');
  const agentList = Object.entries(AGENTS).map(([id, a]) => `- ${id}: ${a.name} (${a.role})`).join('\n');
  const teamList = TEAMS.map(t => `- ${t.id}: ${t.name} (${t.members.join(', ')})`).join('\n');

  const prompt = `Erstelle ein kurzes Ergebnis-Summary für folgendes Diskussionsthema.

## Thema: ${topicName}

## Diskussion
${conversation}

## Verfügbare Agenten
${agentList}

## Teams
${teamList}

Antworte NUR mit einem JSON-Objekt. Kein Markdown, keine \`\`\`json Blöcke.

{
  "name": "${topicName}",
  "context": "1 Satz Rahmen/Hintergrund",
  "outcome": "Was wurde entschieden oder vorgeschlagen? Kurz und klar.",
  "actionItems": [
    { "description": "Konkrete Aktion", "agents": ["agent-id"], "team": "team-id" }
  ]
}

Regeln:
- context: Max 1 Satz
- outcome: Max 2 Sätze. Nur was tatsächlich besprochen wurde.
- actionItems: Nur echte konkrete Aktionen. Kann leer sein wenn nichts beschlossen wurde.
- Alles auf Deutsch.`;

  try {
    let raw = await runClaude(COACH_DIR, prompt);
    raw = raw.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
    return JSON.parse(raw);
  } catch (err) {
    console.error('Topic summary parse error:', err.message);
    return { name: topicName, context: '', outcome: 'Konnte nicht zusammengefasst werden.', actionItems: [] };
  }
}

function hasStarted() {
  return messages.some(m => m.from === 'sebastian');
}

async function orchestrate(triggerType) {
  if (isProcessing) return;
  if (!hasStarted()) {
    // Keine Diskussion ohne Sebastians erste Nachricht
    broadcast('status', { processing: false });
    return;
  }
  isProcessing = true;
  broadcast('status', { processing: true });

  try {
    let instruction;
    if (triggerType === 'start') {
      const namen = activeAgents.map(id => AGENTS[id].name).join(', ');
      instruction = `Eröffne die Diskussion. Die Teilnehmer sind: ${namen}. Sebastian hat gerade eine Nachricht geschickt — lies sie und starte das Gespräch. Halte dich kurz.`;
    } else if (triggerType === 'continue') {
      instruction = `Die Diskussion läuft. Entscheide: Wer soll als nächstes sprechen? Oder reicht es für ein Fazit? Reagiere kurz auf das Bisherige und gib dann deine Direktive.`;
    } else if (triggerType === 'sebastian') {
      instruction = `Sebastian hat sich gerade eingeschaltet. Sein Input steht als letzter Beitrag. Reagiere darauf und steuere die Diskussion weiter.`;
    } else {
      instruction = triggerType;
    }

    // Coach decides
    broadcast('typing', { agent: COACH_ID, typing: true });
    const coachResponse = await runCoach(instruction);
    broadcast('typing', { agent: COACH_ID, typing: false });
    lastCoachResponse = coachResponse;

    const directive = parseDirective(coachResponse);
    const cleanCoach = stripDirective(coachResponse);
    if (cleanCoach) addMessage(COACH_ID, cleanCoach, COACH_ID);

    // Execute directive
    if (directive.type === 'NEXT' || directive.type === 'PROBE') {
      const agentId = directive.target;
      if (!AGENTS[agentId] || agentId === COACH_ID) {
        // Unbekannter Agent oder Coach ruft sich selbst → Sicherheitsstopp
        console.warn(`Ungültige Direktive: ${directive.target}`);
        isProcessing = false;
        broadcast('status', { processing: false });
        return;
      }

      broadcast('typing', { agent: agentId, typing: true });
      const agentResponse = await runAgent(agentId);
      broadcast('typing', { agent: agentId, typing: false });
      addMessage(agentId, agentResponse, agentId);

      await sleep(1000);
      isProcessing = false;
      await nextStep();
      return;

    } else if (directive.type === 'TOPIC') {
      // Neues Thema eröffnen
      currentTopic = { name: directive.name, startMsgId: messages.length };
      broadcast('topic-start', { name: directive.name, startMsgId: currentTopic.startMsgId });

      await sleep(500);
      isProcessing = false;
      await nextStep();
      return;

    } else if (directive.type === 'WRAP') {
      // Thema abschließen — Summary generieren
      if (currentTopic) {
        const topicMessages = messages.slice(currentTopic.startMsgId);
        const topicData = await generateTopicSummary(currentTopic.name, topicMessages);
        topicData.startMsgId = currentTopic.startMsgId;
        topicData.endMsgId = messages.length - 1;
        completedTopics.push(topicData);
        broadcast('topic-wrap', topicData);
        currentTopic = null;
      }

      await sleep(500);
      isProcessing = false;
      await nextStep();
      return;

    } else if (directive.type === 'FAZIT') {
      // Letztes offenes Thema noch wrappen
      if (currentTopic) {
        const topicMessages = messages.slice(currentTopic.startMsgId);
        const topicData = await generateTopicSummary(currentTopic.name, topicMessages);
        topicData.startMsgId = currentTopic.startMsgId;
        topicData.endMsgId = messages.length - 1;
        completedTopics.push(topicData);
        broadcast('topic-wrap', topicData);
        currentTopic = null;
      }
      addMessage(COACH_ID, '📋 Diskussion beendet.', 'system');
      broadcast('status', { finished: true, allTopics: completedTopics });

    } else if (directive.type === 'SEBASTIAN') {
      waitingForSebastian = true;
      if (pendingSebastianMsg) {
        // Sebastian hat schon was geschrieben
        await sleep(500);
        isProcessing = false;
        await nextStep();
        return;
      }
      if (autoMode) {
        // Auto-Modus: nicht warten
        waitingForSebastian = false;
        await sleep(1000);
        isProcessing = false;
        await nextStep();
        return;
      }
      // Manuell: wirklich warten — Pause-resistent
      broadcast('status', { waitingForSebastian: true });

    } else {
      // UNKNOWN directive — Sicherheitsstopp statt Endlosschleife
      console.warn('Unbekannte Direktive, stoppe:', coachResponse.slice(-100));
    }
  } catch (err) {
    console.error('Orchestration error:', err);
    broadcast('error', { message: err.message });
  }

  isProcessing = false;
  broadcast('status', { processing: false });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// --- HTTP Server ---
const MIME = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  // --- API ---
  if (url.pathname === '/api/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });
    res.flushHeaders();
    res.write(`event: init\ndata: ${JSON.stringify({ messages, agents: AGENTS, teams: TEAMS, activeAgents, autoMode, paused, feedbackUrl: FEEDBACK_URL, coachId: COACH_ID })}\n\n`);
    sseClients.push(res);
    req.on('close', () => {
      sseClients = sseClients.filter(c => c !== res);
    });
    return;
  }

  // --- GET endpoints ---
  if (url.pathname === '/api/download') {
    const md = buildChatMarkdown();
    res.writeHead(200, {
      'Content-Type': 'text/markdown; charset=utf-8',
      'Content-Disposition': `attachment; filename="chat-${new Date().toISOString().slice(0,10)}.md"`,
    });
    res.end(md);
    return;
  }

  if (req.method === 'POST') {
    let body = '';
    for await (const chunk of req) body += chunk;
    const data = body ? JSON.parse(body) : {};

    if (url.pathname === '/api/message') {
      // Sebastian sends a message
      const msg = addMessage('sebastian', data.text, 'sebastian');
      paused = false;
      const isFirst = messages.filter(m => m.from === 'sebastian').length === 1;
      if (isFirst) isProcessing = false; // Safety-Reset bei erster Nachricht
      broadcast('status', { paused });
      if (!isFirst && messages.length > 2) {
        // Nur relevante Agenten reagieren — mit verschiedenen Emojis
        const reactors = pickReactingAgents(data.text, activeAgents);
        if (reactors.length > 0) {
          const reactions = reactors.map(id => {
            const r = randomReaction();
            return {
              from: id,
              name: AGENTS[id]?.name || id,
              emoji: r.emoji,
              comment: r.comment,
              avatar: AGENTS[id]?.avatar || null,
              color: AGENTS[id]?.color || '#666',
            };
          });
          setTimeout(() => broadcast('reaction', { messageId: msg.id, reactions }), 400);
        }
      }
      if (isProcessing) {
        pendingSebastianMsg = data.text;
      } else {
        orchestrate(isFirst ? 'start' : 'sebastian');
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (url.pathname === '/api/continue') {
      paused = false;
      broadcast('status', { paused });
      orchestrate('continue');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (url.pathname === '/api/pause') {
      paused = !paused;
      broadcast('status', { paused });
      if (!paused && !isProcessing) {
        // Resume: weiter wo wir waren
        nextStep();
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, paused }));
      return;
    }

    if (url.pathname === '/api/auto') {
      autoMode = data.auto ?? !autoMode;
      broadcast('status', { autoMode });
      if (autoMode && !isProcessing && !paused) orchestrate('continue');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, autoMode }));
      return;
    }

    if (url.pathname === '/api/config') {
      if (data.agents) activeAgents = data.agents;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, activeAgents }));
      return;
    }

    if (url.pathname === '/api/summary') {
      if (messages.length === 0) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ summary: '', actionItems: [] }));
        return;
      }
      broadcast('typing', { agent: COACH_ID, typing: true });
      const agentList = Object.entries(AGENTS).map(([id, a]) => `- ${id}: ${a.name} (${a.role})`).join('\n');
      const teamList = TEAMS.map(t => `- ${t.id}: ${t.name} (${t.members.join(', ')})`).join('\n');

      const prompt = `Du bist ein erfahrener Meeting-Protokollant. Analysiere die folgende Team-Diskussion und erstelle ein strukturiertes Ergebnisprotokoll.

## Diskussion
${buildConversationText()}

## Verfügbare Agenten
${agentList}

## Teams
${teamList}

## Format — STRIKT einhalten

Antworte mit einem JSON-Objekt. Kein Markdown drumherum, keine \`\`\`json Blöcke.

{
  "topics": [
    {
      "title": "Kurze Themen-Überschrift",
      "context": "1-2 Sätze Rahmen/Hintergrund",
      "outcome": "Was wurde entschieden oder vorgeschlagen? Wer war dafür/dagegen?"
    }
  ],
  "openPoints": [
    "Offener Punkt 1",
    "Offener Punkt 2"
  ],
  "nextSteps": [
    { "description": "Konkrete nächste Aktion", "agents": ["agent-id"], "team": "team-id" }
  ]
}

Regeln:
- topics: Jedes Thema, das besprochen wurde. Keine generischen Zusammenfassungen. Outcome = Entscheidung ODER Vorschlag mit Meinungsbild.
- openPoints: Nur echte ungeklärte Fragen oder Dissens.
- nextSteps: Konkrete Action Items mit zuständigen Agenten-IDs und Team-ID. Nur was wirklich gesagt oder beschlossen wurde.
- Alles auf Deutsch, kurz und klar. Erfinde nichts dazu.`;

      try {
        let raw = await runClaude(COACH_DIR, prompt);
        broadcast('typing', { agent: COACH_ID, typing: false });
        raw = raw.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
        const result = JSON.parse(raw);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (err) {
        broadcast('typing', { agent: COACH_ID, typing: false });
        console.error('Summary parse error:', err.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    if (url.pathname === '/api/action-items') {
      if (messages.length === 0) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ items: [] }));
        return;
      }
      broadcast('typing', { agent: COACH_ID, typing: true });
      const agentList = Object.entries(AGENTS).map(([id, a]) => `- ${id}: ${a.name} (${a.role})`).join('\n');
      const teamList = TEAMS.map(t => `- ${t.id}: ${t.name} (${t.members.join(', ')})`).join('\n');

      const prompt = `Du bist ein Projekt-Manager. Analysiere die folgende Team-Diskussion und extrahiere konkrete Action Items.

## Diskussion
${buildConversationText()}

## Verfügbare Agenten
${agentList}

## Teams
${teamList}

Antworte NUR mit einem JSON-Array. Kein Markdown, kein Text drumherum, keine \`\`\`json Blöcke.
Jedes Element: { "description": "...", "agents": ["agent-id", ...], "team": "team-id" }

Regeln:
- Nur echte, konkrete Action Items aus der Diskussion. Keine generischen Empfehlungen.
- "agents" enthält die IDs der zuständigen Agenten (z.B. "boris", "rina")
- "team" ist die Team-ID (spotlight, inf-ops, oder meta)
- Beschreibung auf Deutsch, kurz und konkret
- Wenn ein Action Item mehrere Agenten betrifft, alle in "agents" auflisten`;

      try {
        let raw = await runClaude(COACH_DIR, prompt);
        broadcast('typing', { agent: COACH_ID, typing: false });
        // Strip markdown fences if present
        raw = raw.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
        const items = JSON.parse(raw);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ items }));
      } catch (err) {
        broadcast('typing', { agent: COACH_ID, typing: false });
        console.error('Action items parse error:', err.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Konnte Action Items nicht parsen: ' + err.message }));
      }
      return;
    }

    if (url.pathname === '/api/action-items/save') {
      const items = data.items || [];
      if (items.length === 0) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, path: null }));
        return;
      }
      const now = new Date();
      const stamp = now.toISOString().slice(0, 16).replace('T', '-').replace(':', '');
      const dir = path.join(ROOT, 'action-items');
      fs.mkdirSync(dir, { recursive: true });
      const filePath = path.join(dir, `${stamp}.md`);

      // Group by team
      const byTeam = {};
      for (const item of items) {
        const teamId = item.team || 'sonstige';
        if (!byTeam[teamId]) byTeam[teamId] = [];
        byTeam[teamId].push(item);
      }

      let md = `# Action Items — ${now.toLocaleDateString('de-DE')} ${now.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })}\n\nAus Team-Diskussion generiert.\n\n`;
      for (const [teamId, teamItems] of Object.entries(byTeam)) {
        const team = TEAMS.find(t => t.id === teamId);
        md += `## ${team ? team.name : teamId}\n`;
        for (const item of teamItems) {
          const agentNames = item.agents.map(id => AGENTS[id]?.name || id).join(', ');
          md += `- [ ] ${item.description} → **${agentNames}**\n`;
        }
        md += '\n';
      }

      fs.writeFileSync(filePath, md);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, path: `action-items/${stamp}.md` }));
      return;
    }

    if (url.pathname === '/api/reset') {
      messages = [];
      lastCoachResponse = '';
      isProcessing = false;
      autoMode = false;
      currentTopic = null;
      completedTopics = [];
      broadcast('reset', {});
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
  }

  // --- Static files ---
  let filePath = url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname);
  filePath = path.join(__dirname, 'public', filePath);

  // Resolve symlinks
  try { filePath = fs.realpathSync(filePath); } catch {}

  try {
    const content = fs.readFileSync(filePath);
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(content);
  } catch {
    res.writeHead(404);
    res.end('Not found');
  }
});

server.listen(PORT, () => {
  console.log(`\n  🟢 Agenten-Chat läuft auf http://localhost:${PORT}\n`);
  console.log(`  Aktive Agenten: ${activeAgents.map(id => AGENTS[id].name).join(', ')}`);
  console.log(`  Tipp: Öffne die URL im Browser und schreib eine Nachricht!\n`);
});
