// --- State ---
let agents = {};
let teams = [];
let activeAgents = [];
let autoMode = false;
let feedbackUrl = '';
let coachId = 'coach';
let lastSenderId = null;
let canContinue = false; // true when agents are idle and could continue

const messagesEl = document.getElementById('messages');
const inputEl = document.getElementById('message-input');
const actionBtn = document.getElementById('btn-action');
const autoBtn = document.getElementById('btn-auto');
const pauseBtn = document.getElementById('btn-pause');
let isPaused = false;
const typingEl = document.getElementById('typing-indicator');
const typingAvatar = document.getElementById('typing-avatar');
const typingName = document.getElementById('typing-name');
const headerParticipants = document.getElementById('header-participants');
const agentToggles = document.getElementById('agent-toggles');
const topicInput = document.getElementById('topic-input');
const goBtn = document.getElementById('btn-go');
const iconSend = actionBtn.querySelector('.icon-send');
const iconPlay = actionBtn.querySelector('.icon-play');

function updateActionBtn() {
  const hasText = inputEl.value.trim().length > 0;
  if (hasText) {
    // Send mode
    iconSend.classList.remove('hidden');
    iconPlay.classList.add('hidden');
    actionBtn.classList.remove('mode-play');
    actionBtn.dataset.tooltip = 'Senden';
  } else {
    // Continue mode
    iconSend.classList.add('hidden');
    iconPlay.classList.remove('hidden');
    actionBtn.classList.add('mode-play');
    actionBtn.dataset.tooltip = 'Weiter';
  }
}

// --- SSE Connection ---
function connect() {
  const sse = new EventSource('/api/events');

  sse.addEventListener('init', (e) => {
    const data = JSON.parse(e.data);
    agents = data.agents;
    teams = data.teams || [];
    activeAgents = data.activeAgents;
    autoMode = data.autoMode;
    feedbackUrl = data.feedbackUrl || '';
    coachId = data.coachId || 'coach';
    isPaused = data.paused || false;
    if (!feedbackUrl) document.getElementById('btn-feedback').classList.add('hidden');

    updateHeader();
    renderAgentToggles();
    updateAutoBtn();
    updatePauseBtn();
    updateActionBtn();

    // Render existing messages
    messagesEl.innerHTML = '';
    if (data.messages.length === 0) {
      messagesEl.innerHTML = '<div class="system-message"><span>Schreib eine Nachricht, um die Diskussion zu starten 👇</span></div>';
    }
    lastSenderId = null;
    data.messages.forEach(msg => appendMessage(msg));
    scrollToBottom();
  });

  sse.addEventListener('message', (e) => {
    const msg = JSON.parse(e.data);
    // Remove "start" hint if present
    const hint = messagesEl.querySelector('.system-message');
    if (hint && messagesEl.children.length === 1) hint.remove();
    appendMessage(msg);
    scrollToBottom();
  });

  sse.addEventListener('typing', (e) => {
    const data = JSON.parse(e.data);
    if (data.typing) {
      const agent = agents[data.agent];
      if (agent) {
        typingAvatar.innerHTML = agent.avatar
          ? `<img src="${agent.avatar}" alt="${agent.name}">`
          : agent.name.charAt(0);
        typingAvatar.style.background = agent.color + '33';
        typingName.textContent = agent.name;
        typingName.style.color = agent.color;
      }
      typingEl.classList.remove('hidden');
      scrollToBottom();
    } else {
      typingEl.classList.add('hidden');
    }
  });

  sse.addEventListener('status', (e) => {
    const data = JSON.parse(e.data);
    if (data.processing !== undefined) {
      canContinue = !data.processing && !autoMode;
    }
    if (data.paused !== undefined) {
      isPaused = data.paused;
      updatePauseBtn();
    }
    if (data.autoMode !== undefined) {
      autoMode = data.autoMode;
      updateAutoBtn();
    }
    if (data.finished) {
      appendSystemMessage('Diskussion beendet ✅');
      canContinue = false;
      // Show meeting wrap-up with all approved items
      setTimeout(() => showMeetingWrapup(), 500);
    }
    if (data.waitingForSebastian) {
      appendSystemMessage('Coach wartet auf deine Antwort...');
    }
  });

  sse.addEventListener('topic-start', (e) => {
    const data = JSON.parse(e.data);
    const div = document.createElement('div');
    div.className = 'topic-start';
    div.dataset.topicStart = data.startMsgId;
    div.innerHTML = `<span>📌 ${data.name}</span>`;
    messagesEl.appendChild(div);
    lastSenderId = null;
    scrollToBottom();
  });

  sse.addEventListener('topic-wrap', (e) => {
    const data = JSON.parse(e.data);
    foldTopic(data);
    scrollToBottom();
  });

  sse.addEventListener('reaction', (e) => {
    const data = JSON.parse(e.data);
    const msgEl = messagesEl.querySelector(`[data-msg-id="${data.messageId}"]`);
    if (!msgEl) return;
    const bubble = msgEl.querySelector('.message-bubble');
    if (!bubble) return;

    const existing = bubble.querySelector('.message-reactions');
    if (existing) existing.remove();

    const reactionsDiv = document.createElement('div');
    reactionsDiv.className = 'message-reactions';

    // Ein Badge pro Emoji, mit Popup das die Reagierenden zeigt
    const byEmoji = {};
    for (const r of data.reactions) {
      if (!byEmoji[r.emoji]) byEmoji[r.emoji] = [];
      byEmoji[r.emoji].push(r);
    }

    for (const [emoji, reactors] of Object.entries(byEmoji)) {
      const badge = document.createElement('div');
      badge.className = 'reaction-badge';
      badge.innerHTML = reactors.length > 1
        ? `${emoji} <span class="reaction-count">${reactors.length}</span>`
        : emoji;

      const popup = document.createElement('div');
      popup.className = 'reaction-popup';
      popup.innerHTML = reactors.map(r => {
        const avatarHtml = r.avatar
          ? `<img src="${r.avatar}" alt="${r.name}">`
          : r.name.charAt(0);
        return `
          <div class="reaction-popup-item">
            <div class="reaction-popup-avatar" style="background: ${r.color}33">${avatarHtml}</div>
            <div class="reaction-popup-text">
              <div class="reaction-popup-name" style="color: ${r.color}">${r.name.split(' ')[0]}</div>
              <div class="reaction-popup-comment">${r.comment}</div>
            </div>
          </div>
        `;
      }).join('');

      badge.appendChild(popup);
      reactionsDiv.appendChild(badge);
    }

    bubble.appendChild(reactionsDiv);
    scrollToBottom();
  });

  sse.addEventListener('reset', () => {
    messagesEl.innerHTML = '<div class="system-message"><span>Schreib eine Nachricht, um die Diskussion zu starten 👇</span></div>';
    lastSenderId = null;
    canContinue = false;
    typingEl.classList.add('hidden');
    updateActionBtn();
  });

  sse.addEventListener('error', () => {
    appendSystemMessage('Verbindung verloren — versuche Reconnect...');
  });

  sse.onerror = () => {
    setTimeout(connect, 2000);
  };
}

// --- Render ---
function appendMessage(msg) {
  const isOutgoing = msg.from === 'sebastian';
  const isSameSender = lastSenderId === msg.from;
  lastSenderId = msg.from;

  const div = document.createElement('div');
  div.className = `message ${isOutgoing ? 'outgoing' : 'incoming'} ${isSameSender ? 'same-sender' : ''}`;
  div.dataset.msgId = msg.id;

  const agent = agents[msg.from];
  const color = msg.color || agent?.color || '#8696A0';
  const avatar = msg.avatar || agent?.avatar;
  const role = agent?.role || '';

  if (!isOutgoing) {
    const avatarHtml = avatar
      ? `<img src="${avatar}" alt="${msg.name}">`
      : msg.name.charAt(0);
    div.innerHTML = `
      <div class="message-avatar-col">
        <div class="message-avatar" style="background: ${color}33">${avatarHtml}</div>
      </div>
      <div class="message-bubble">
        <div class="message-sender" style="color: ${color}">
          ${msg.name}
          ${role ? `<span class="message-sender-role">${role}</span>` : ''}
        </div>
        <div class="message-text">${formatText(msg.text)}</div>
        <div class="message-meta">
          <span class="message-time">${msg.time}</span>
        </div>
      </div>
    `;
  } else {
    div.innerHTML = `
      <div class="message-bubble">
        <div class="message-text">${formatText(msg.text)}</div>
        <div class="message-meta">
          <span class="message-time">${msg.time}</span>
          <span class="message-check">✓✓</span>
        </div>
      </div>
    `;
  }

  messagesEl.appendChild(div);
}

// --- Topic Folding ---
let allTopicData = []; // collect for meeting end

function foldTopic(data) {
  allTopicData.push(data);
  const itemStatuses = (data.actionItems || []).map(() => null);

  // Collect messages that belong to this topic
  const topicStartEl = messagesEl.querySelector(`[data-topic-start="${data.startMsgId}"]`);
  const messagesToFold = [];

  // Gather all elements between topic-start and now
  let el = topicStartEl ? topicStartEl.nextElementSibling : null;
  while (el) {
    const next = el.nextElementSibling;
    // Stop if we hit another topic-start
    if (el.classList?.contains('topic-start')) break;
    messagesToFold.push(el);
    el = next;
  }

  // Remove the topic-start marker
  topicStartEl?.remove();

  // Create the folded card
  const card = document.createElement('div');
  card.className = 'topic-card';
  card.dataset.topicName = data.name;

  const actionCount = (data.actionItems || []).length;
  const badgeHtml = actionCount > 0
    ? `<div class="topic-card-badge"><span class="count">${actionCount}</span> Actions</div>`
    : '';

  card.innerHTML = `
    <div class="topic-card-header">
      <div class="topic-card-icon">✅</div>
      <div class="topic-card-info">
        <div class="topic-card-title">${data.name}</div>
        <div class="topic-card-outcome">${data.outcome || ''}</div>
      </div>
      ${badgeHtml}
      <div class="topic-card-chevron">▼</div>
    </div>
    <div class="topic-card-body">
      <div class="topic-card-context">${data.context || ''}</div>
      <div class="topic-card-result">${formatText(data.outcome || '')}</div>
      <div class="topic-card-items"></div>
      <button class="topic-card-show-msgs">💬 Diskussion anzeigen</button>
      <div class="topic-card-messages"></div>
    </div>
  `;

  // Toggle expand/collapse
  card.querySelector('.topic-card-header').addEventListener('click', () => {
    card.classList.toggle('expanded');
  });

  // Render action items
  function renderItems() {
    const container = card.querySelector('.topic-card-items');
    if (!data.actionItems || data.actionItems.length === 0) {
      container.innerHTML = '';
      return;
    }
    container.innerHTML = `<div class="topic-card-actions-title">Nächste Schritte</div>` +
      data.actionItems.map((item, i) => {
        const statusClass = itemStatuses[i] === 'approved' ? 'approved' : itemStatuses[i] === 'rejected' ? 'rejected' : '';
        const agentBadges = (item.agents || []).map(id => {
          const a = agents[id];
          return a ? `<span class="agent-badge" style="background: ${a.color}">${a.name.split(' ')[0]}</span>` : '';
        }).join('');
        return `
          <div class="action-item ${statusClass}" data-idx="${i}">
            <div class="action-item-body">
              <div class="action-item-desc">${item.description}</div>
              <div class="action-item-meta">${agentBadges}</div>
            </div>
            <div class="action-item-btns">
              <button class="btn-approve" data-idx="${i}">✓</button>
              <button class="btn-reject" data-idx="${i}">✕</button>
            </div>
          </div>
        `;
      }).join('');
  }
  renderItems();

  // Action item clicks
  card.querySelector('.topic-card-items').addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    const idx = parseInt(btn.dataset.idx);
    if (isNaN(idx)) return;
    if (btn.classList.contains('btn-approve')) {
      itemStatuses[idx] = itemStatuses[idx] === 'approved' ? null : 'approved';
    } else if (btn.classList.contains('btn-reject')) {
      itemStatuses[idx] = itemStatuses[idx] === 'rejected' ? null : 'rejected';
    }
    // Store on topic data for meeting end
    data._statuses = itemStatuses;
    renderItems();
  });

  // Move original messages into expandable section
  const msgsContainer = card.querySelector('.topic-card-messages');
  for (const m of messagesToFold) {
    msgsContainer.appendChild(m);
  }

  card.querySelector('.topic-card-show-msgs').addEventListener('click', () => {
    msgsContainer.classList.toggle('show');
  });

  // Insert card where topic started
  messagesEl.appendChild(card);
  lastSenderId = null;
}

function showMeetingWrapup() {
  // Collect all approved action items across all topics
  const allApproved = [];
  for (const topic of allTopicData) {
    const statuses = topic._statuses || [];
    if (!topic.actionItems) continue;
    topic.actionItems.forEach((item, i) => {
      if (statuses[i] === 'approved') {
        allApproved.push({ ...item, topic: topic.name });
      }
    });
  }

  if (allApproved.length === 0 && allTopicData.length === 0) return;

  document.getElementById('wrapup-modal')?.remove();
  const modal = document.createElement('div');
  modal.id = 'wrapup-modal';

  let topicsHtml = allTopicData.map(t => {
    const approvedCount = (t._statuses || []).filter(s => s === 'approved').length;
    const total = (t.actionItems || []).length;
    const badge = total > 0 ? ` — <strong>${approvedCount}/${total}</strong> Actions genehmigt` : '';
    return `<li><strong>${t.name}</strong>${badge}<br><span style="color: var(--wa-text-secondary)">${t.outcome || ''}</span></li>`;
  }).join('');

  let itemsHtml = '';
  if (allApproved.length > 0) {
    itemsHtml = `<div class="summary-section-title">Genehmigte Action Items (${allApproved.length})</div>` +
      allApproved.map(item => {
        const agentBadges = (item.agents || []).map(id => {
          const a = agents[id];
          return a ? `<span class="agent-badge" style="background: ${a.color}">${a.name.split(' ')[0]}</span>` : '';
        }).join(' ');
        return `<div style="padding: 8px 0; border-bottom: 1px solid #f0f0f0;">
          <div style="font-size: 14px; margin-bottom: 4px;">${item.description}</div>
          <div>${agentBadges} <span class="team-badge">${item.topic}</span></div>
        </div>`;
      }).join('');
  }

  const pendingCount = allTopicData.reduce((sum, t) => {
    const statuses = t._statuses || [];
    return sum + (t.actionItems || []).filter((_, i) => !statuses[i]).length;
  }, 0);
  const pendingHint = pendingCount > 0
    ? `<p style="color: var(--wa-text-secondary); font-size: 12px; margin-top: 12px;">💡 ${pendingCount} Action Items noch nicht bewertet — scrolle hoch zu den Topic-Cards um sie zu approven.</p>`
    : '';

  modal.innerHTML = `
    <div class="modal-backdrop"></div>
    <div class="modal-content" style="max-width: 640px;">
      <div class="modal-header">
        <span>Meeting beendet</span>
        <button class="modal-close">&times;</button>
      </div>
      <div class="modal-body">
        <div class="summary-section-title">Besprochene Themen</div>
        <ul class="summary-list">${topicsHtml}</ul>
        ${itemsHtml}
        ${pendingHint}
      </div>
      <div class="modal-footer">
        <button class="modal-btn" id="wrapup-download">Protokoll herunterladen</button>
        ${allApproved.length > 0 ? '<button class="modal-btn modal-btn-green" id="wrapup-save">Action Items speichern</button>' : ''}
        <button class="modal-btn" id="wrapup-close">Schließen</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);

  const close = () => modal.remove();
  modal.querySelector('.modal-backdrop').addEventListener('click', close);
  modal.querySelector('.modal-close').addEventListener('click', close);
  modal.querySelector('#wrapup-close').addEventListener('click', close);

  modal.querySelector('#wrapup-download')?.addEventListener('click', () => {
    let md = `# Meeting-Protokoll — ${new Date().toLocaleDateString('de-DE')}\n\n`;
    for (const t of allTopicData) {
      md += `## ${t.name}\n\n${t.context || ''}\n\n**Ergebnis:** ${t.outcome || ''}\n\n`;
      const statuses = t._statuses || [];
      const approved = (t.actionItems || []).filter((_, i) => statuses[i] === 'approved');
      if (approved.length > 0) {
        md += `**Action Items:**\n`;
        for (const a of approved) {
          const names = (a.agents || []).map(id => agents[id]?.name || id).join(', ');
          md += `- [ ] ${a.description} → **${names}**\n`;
        }
        md += '\n';
      }
    }
    const blob = new Blob([md], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `meeting-${new Date().toISOString().slice(0,10)}.md`;
    a.click();
    URL.revokeObjectURL(url);
    modal.querySelector('#wrapup-download').textContent = 'Gespeichert ✓';
  });

  modal.querySelector('#wrapup-save')?.addEventListener('click', async () => {
    const saveBtn = modal.querySelector('#wrapup-save');
    saveBtn.disabled = true;
    saveBtn.textContent = 'Speichere...';
    try {
      const res = await fetch('/api/action-items/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: allApproved }),
      });
      const result = await res.json();
      saveBtn.textContent = result.path ? 'Gespeichert ✓' : 'Fehler';
    } catch {
      saveBtn.textContent = 'Fehler';
    }
  });
}

function appendSystemMessage(text) {
  const div = document.createElement('div');
  div.className = 'system-message';
  div.innerHTML = `<span>${text}</span>`;
  messagesEl.appendChild(div);
  lastSenderId = null;
  scrollToBottom();
}

function formatText(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/\n/g, '<br>');
}

function scrollToBottom() {
  requestAnimationFrame(() => {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  });
}

function updateHeader() {
  const names = activeAgents
    .filter(id => id !== coachId)
    .map(id => agents[id]?.name?.split(' ')[0])
    .filter(Boolean);
  names.unshift('Du');
  names.push(agents[coachId]?.name?.split(' ')[0] || 'Coach');
  headerParticipants.textContent = names.join(', ');
}

function renderAgentToggles() {
  agentToggles.innerHTML = '';

  for (const team of teams) {
    const group = document.createElement('div');
    group.className = 'team-group';
    group.dataset.teamId = team.id;

    group.innerHTML = `
      <div class="team-header">
        <div class="team-name">${team.name}</div>
        <div class="team-check" data-team-check="${team.id}"></div>
      </div>
      <div class="team-members"></div>
    `;

    // Team header click → toggle all members
    group.querySelector('.team-header').addEventListener('click', () => {
      const nonCoachMembers = team.members.filter(id => id !== coachId);
      const allIn = nonCoachMembers.every(id => activeAgents.includes(id));
      if (allIn) {
        for (const id of nonCoachMembers) {
          const idx = activeAgents.indexOf(id);
          if (idx >= 0) activeAgents.splice(idx, 1);
        }
      } else {
        for (const id of nonCoachMembers) {
          if (!activeAgents.includes(id)) activeAgents.push(id);
        }
      }
      syncAgents();
    });

    // Render members (once — images stay in DOM)
    const membersEl = group.querySelector('.team-members');
    for (const id of team.members) {
      const agent = agents[id];
      if (!agent) continue;
      const isCoach = id === coachId;
      const div = document.createElement('div');
      div.className = 'agent-toggle';
      const avatarHtml = agent.avatar
        ? `<img src="${agent.avatar}" alt="${agent.name}">`
        : agent.name.charAt(0);
      div.innerHTML = `
        <div class="agent-toggle-avatar" style="background: ${agent.color}33">${avatarHtml}</div>
        <div class="agent-toggle-name">${agent.name} <span style="color: var(--wa-text-secondary); font-size: 11px">${agent.role}</span></div>
        <div class="agent-toggle-check" data-agent-check="${id}"></div>
      `;
      if (!isCoach) div.addEventListener('click', () => { toggleAgent(id); });
      membersEl.appendChild(div);
    }

    agentToggles.appendChild(group);
  }
  updateCheckmarks();
}

function updateCheckmarks() {
  // Update agent checkmarks
  for (const el of agentToggles.querySelectorAll('[data-agent-check]')) {
    const id = el.dataset.agentCheck;
    const isCoach = id === coachId;
    const isActive = isCoach || activeAgents.includes(id);
    el.className = `agent-toggle-check ${isActive ? 'active' : ''}`;
    el.textContent = isActive ? '✓' : '';
  }
  // Update team checkmarks
  for (const team of teams) {
    const el = agentToggles.querySelector(`[data-team-check="${team.id}"]`);
    if (!el) continue;
    const activeCount = team.members.filter(id => id === coachId || activeAgents.includes(id)).length;
    const allActive = activeCount === team.members.length;
    const someActive = activeCount > 0 && !allActive;
    el.className = `team-check ${allActive ? 'all' : someActive ? 'some' : ''}`;
    el.textContent = activeCount > 0 ? '✓' : '';
  }
}

function syncAgents() {
  fetch('/api/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agents: activeAgents }),
  });
  updateHeader();
  updateCheckmarks();
}

function toggleAgent(id) {
  const idx = activeAgents.indexOf(id);
  if (idx >= 0) {
    activeAgents.splice(idx, 1);
  } else {
    activeAgents.push(id);
  }
  syncAgents();
}

function updateAutoBtn() {
  autoBtn.classList.toggle('auto-active', autoMode);
  autoBtn.classList.toggle('auto-inactive', !autoMode);
  autoBtn.classList.toggle('header-pill', true);
  autoBtn.dataset.tooltip = autoMode ? 'Auto aus' : 'Auto an';
}

// --- Actions ---
async function handleAction() {
  const text = inputEl.value.trim();
  if (text) {
    // Send message
    inputEl.value = '';
    inputEl.style.height = 'auto';
    updateActionBtn();
    await fetch('/api/message', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
  } else {
    // Continue
    canContinue = false;
    await fetch('/api/continue', { method: 'POST' });
  }
}

function updatePauseBtn() {
  const pauseIcon = pauseBtn.querySelector('.pause-icon');
  const playIcon = pauseBtn.querySelector('.play-icon');
  const indicator = document.getElementById('paused-indicator');
  if (isPaused) {
    pauseIcon.classList.add('hidden');
    playIcon.classList.remove('hidden');
    pauseBtn.dataset.tooltip = 'Fortsetzen';
    indicator.classList.remove('hidden');
  } else {
    pauseIcon.classList.remove('hidden');
    playIcon.classList.add('hidden');
    pauseBtn.dataset.tooltip = 'Pause';
    indicator.classList.add('hidden');
  }
}

async function togglePause() {
  await fetch('/api/pause', { method: 'POST' });
}

async function toggleAuto() {
  autoMode = !autoMode;
  updateAutoBtn();
  await fetch('/api/auto', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ auto: autoMode }),
  });
}

async function downloadChat() {
  const a = document.createElement('a');
  a.href = '/api/download';
  a.download = '';
  a.click();
}

async function generateActionItems() {
  const btn = document.getElementById('btn-action-items');
  btn.disabled = true;
  btn.style.opacity = '0.4';

  // Show loading modal immediately
  showLoadingModal('Action Items werden generiert...');

  try {
    const res = await fetch('/api/action-items', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    const data = await res.json();
    closeLoadingModal();
    if (data.error) {
      showActionItemsModal([]);
    } else {
      showActionItemsModal(data.items || []);
    }
  } catch (err) {
    closeLoadingModal();
    showActionItemsModal([]);
  }

  btn.disabled = false;
  btn.style.opacity = '';
}

function showLoadingModal(text) {
  closeLoadingModal();
  const modal = document.createElement('div');
  modal.id = 'loading-modal';
  modal.innerHTML = `
    <div class="modal-backdrop"></div>
    <div class="modal-content" style="max-width: 340px; text-align: center; padding: 40px 20px;">
      <div class="typing-dots" style="justify-content: center; margin-bottom: 16px;">
        <span></span><span></span><span></span>
      </div>
      <div style="color: var(--wa-text-secondary); font-size: 14px;">${text}</div>
    </div>
  `;
  document.body.appendChild(modal);
}

function closeLoadingModal() {
  document.getElementById('loading-modal')?.remove();
}

function showActionItemsModal(items) {
  document.getElementById('action-items-modal')?.remove();

  const modal = document.createElement('div');
  modal.id = 'action-items-modal';

  // Track status per item
  const statuses = items.map(() => null); // null = pending

  function renderItems() {
    const body = modal.querySelector('.modal-body');
    if (!body) return;

    if (items.length === 0) {
      body.innerHTML = '<p style="color: var(--wa-text-secondary)">Keine Action Items gefunden.</p>';
      return;
    }

    body.innerHTML = items.map((item, i) => {
      const statusClass = statuses[i] === 'approved' ? 'approved' : statuses[i] === 'rejected' ? 'rejected' : '';
      const agentBadges = (item.agents || []).map(id => {
        const a = agents[id];
        return a ? `<span class="agent-badge" style="background: ${a.color}">${a.name.split(' ')[0]}</span>` : '';
      }).join('');
      const team = teams.find(t => t.id === item.team);
      const teamBadge = team ? `<span class="team-badge">${team.name}</span>` : '';

      return `
        <div class="action-item ${statusClass}" data-idx="${i}">
          <div class="action-item-body">
            <div class="action-item-desc">${item.description}</div>
            <div class="action-item-meta">${agentBadges} ${teamBadge}</div>
          </div>
          <div class="action-item-btns">
            <button class="btn-approve" data-idx="${i}" title="Genehmigen">✓</button>
            <button class="btn-reject" data-idx="${i}" title="Ablehnen">✕</button>
          </div>
        </div>
      `;
    }).join('');

    // Update save button
    const saveBtn = modal.querySelector('#ai-save');
    const approvedCount = statuses.filter(s => s === 'approved').length;
    if (saveBtn) {
      saveBtn.disabled = approvedCount === 0;
      saveBtn.textContent = approvedCount > 0 ? `Speichern (${approvedCount})` : 'Speichern';
    }
  }

  modal.innerHTML = `
    <div class="modal-backdrop"></div>
    <div class="modal-content">
      <div class="modal-header">
        <span>☑ Action Items</span>
        <button class="modal-close">&times;</button>
      </div>
      <div class="modal-body"></div>
      <div class="modal-footer">
        <button class="modal-btn" id="ai-approve-all">Alle genehmigen</button>
        <button class="modal-btn modal-btn-green" id="ai-save" disabled>Speichern</button>
        <button class="modal-btn" id="ai-close">Schließen</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
  renderItems();

  // Event delegation for approve/reject buttons
  modal.querySelector('.modal-body').addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    const idx = parseInt(btn.dataset.idx);
    if (isNaN(idx)) return;

    if (btn.classList.contains('btn-approve')) {
      statuses[idx] = statuses[idx] === 'approved' ? null : 'approved';
    } else if (btn.classList.contains('btn-reject')) {
      statuses[idx] = statuses[idx] === 'rejected' ? null : 'rejected';
    }
    renderItems();
  });

  const close = () => modal.remove();
  modal.querySelector('.modal-backdrop').addEventListener('click', close);
  modal.querySelector('.modal-close').addEventListener('click', close);
  modal.querySelector('#ai-close').addEventListener('click', close);

  modal.querySelector('#ai-approve-all').addEventListener('click', () => {
    for (let i = 0; i < statuses.length; i++) statuses[i] = 'approved';
    renderItems();
  });

  modal.querySelector('#ai-save').addEventListener('click', async () => {
    const approved = items.filter((_, i) => statuses[i] === 'approved');
    const saveBtn = modal.querySelector('#ai-save');
    saveBtn.disabled = true;
    saveBtn.textContent = 'Speichere...';
    try {
      const res = await fetch('/api/action-items/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: approved }),
      });
      const data = await res.json();
      saveBtn.textContent = data.path ? `Gespeichert ✓` : 'Fehler';
    } catch {
      saveBtn.textContent = 'Fehler';
    }
  });
}

async function generateSummary() {
  const btn = document.getElementById('btn-summary');
  btn.disabled = true;
  btn.style.opacity = '0.4';

  showLoadingModal('Ergebnisprotokoll wird erstellt...');

  try {
    const res = await fetch('/api/summary', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    const data = await res.json();
    closeLoadingModal();
    if (data.error) {
      showSummaryModal({ topics: [], openPoints: [data.error], nextSteps: [] });
    } else {
      showSummaryModal(data);
    }
  } catch (err) {
    closeLoadingModal();
    showSummaryModal({ topics: [], openPoints: ['Fehler: ' + err.message], nextSteps: [] });
  }

  btn.disabled = false;
  btn.style.opacity = '';
}

function showSummaryModal(data) {
  document.getElementById('summary-modal')?.remove();

  const topics = data.topics || [];
  const openPoints = data.openPoints || [];
  const nextSteps = data.nextSteps || [];
  const stepStatuses = nextSteps.map(() => null);

  const modal = document.createElement('div');
  modal.id = 'summary-modal';

  function renderBody() {
    const body = modal.querySelector('.modal-body');
    if (!body) return;

    let html = '';

    // Topics
    for (const t of topics) {
      html += `<div class="summary-topic">`;
      html += `<div class="summary-topic-title">${formatText(t.title)}</div>`;
      html += `<div class="summary-topic-context">${formatText(t.context)}</div>`;
      html += `<div class="summary-topic-outcome">${formatText(t.outcome)}</div>`;
      html += `</div>`;
    }

    // Open Points
    if (openPoints.length > 0) {
      html += `<div class="summary-section-title">Offene Punkte</div>`;
      html += `<ul class="summary-list">`;
      for (const p of openPoints) html += `<li>${formatText(p)}</li>`;
      html += `</ul>`;
    }

    // Next Steps / Action Items
    if (nextSteps.length > 0) {
      html += `<div class="summary-section-title">Nächste Schritte</div>`;
      html += nextSteps.map((step, i) => {
        const statusClass = stepStatuses[i] === 'approved' ? 'approved' : stepStatuses[i] === 'rejected' ? 'rejected' : '';
        const agentBadges = (step.agents || []).map(id => {
          const a = agents[id];
          return a ? `<span class="agent-badge" style="background: ${a.color}">${a.name.split(' ')[0]}</span>` : '';
        }).join('');
        const team = teams.find(t => t.id === step.team);
        const teamBadge = team ? `<span class="team-badge">${team.name}</span>` : '';
        return `
          <div class="action-item ${statusClass}" data-idx="${i}">
            <div class="action-item-body">
              <div class="action-item-desc">${step.description}</div>
              <div class="action-item-meta">${agentBadges} ${teamBadge}</div>
            </div>
            <div class="action-item-btns">
              <button class="btn-approve" data-idx="${i}" title="Annehmen">✓</button>
              <button class="btn-reject" data-idx="${i}" title="Ablehnen">✕</button>
            </div>
          </div>
        `;
      }).join('');
    }

    body.innerHTML = html;

    // Update save button
    const approvedCount = stepStatuses.filter(s => s === 'approved').length;
    const saveBtn = modal.querySelector('#summary-save');
    if (saveBtn) {
      saveBtn.disabled = approvedCount === 0;
      saveBtn.textContent = approvedCount > 0 ? `Action Items speichern (${approvedCount})` : 'Action Items speichern';
    }
  }

  modal.innerHTML = `
    <div class="modal-backdrop"></div>
    <div class="modal-content" style="max-width: 720px;">
      <div class="modal-header">
        <span>Ergebnisprotokoll</span>
        <button class="modal-close">&times;</button>
      </div>
      <div class="modal-body"></div>
      <div class="modal-footer">
        <button class="modal-btn" id="summary-download">Herunterladen</button>
        <button class="modal-btn modal-btn-green" id="summary-save" disabled>Action Items speichern</button>
        <button class="modal-btn" id="summary-close">Schließen</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
  renderBody();

  // Approve/reject clicks
  modal.querySelector('.modal-body').addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    const idx = parseInt(btn.dataset.idx);
    if (isNaN(idx)) return;
    if (btn.classList.contains('btn-approve')) {
      stepStatuses[idx] = stepStatuses[idx] === 'approved' ? null : 'approved';
    } else if (btn.classList.contains('btn-reject')) {
      stepStatuses[idx] = stepStatuses[idx] === 'rejected' ? null : 'rejected';
    }
    renderBody();
  });

  const close = () => modal.remove();
  modal.querySelector('.modal-backdrop').addEventListener('click', close);
  modal.querySelector('.modal-close').addEventListener('click', close);
  modal.querySelector('#summary-close').addEventListener('click', close);

  modal.querySelector('#summary-save').addEventListener('click', async () => {
    const approved = nextSteps.filter((_, i) => stepStatuses[i] === 'approved');
    const saveBtn = modal.querySelector('#summary-save');
    saveBtn.disabled = true;
    saveBtn.textContent = 'Speichere...';
    try {
      const res = await fetch('/api/action-items/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: approved }),
      });
      const result = await res.json();
      saveBtn.textContent = result.path ? 'Gespeichert ✓' : 'Fehler';
    } catch {
      saveBtn.textContent = 'Fehler';
    }
  });

  modal.querySelector('#summary-download').addEventListener('click', () => {
    let md = `# Ergebnisprotokoll — ${new Date().toLocaleDateString('de-DE')}\n\n`;
    for (const t of topics) {
      md += `## ${t.title}\n\n${t.context}\n\n**Ergebnis:** ${t.outcome}\n\n`;
    }
    if (openPoints.length > 0) {
      md += `## Offene Punkte\n\n`;
      for (const p of openPoints) md += `- ${p}\n`;
      md += '\n';
    }
    if (nextSteps.length > 0) {
      md += `## Nächste Schritte\n\n`;
      for (const s of nextSteps) {
        const names = (s.agents || []).map(id => agents[id]?.name || id).join(', ');
        md += `- [ ] ${s.description} → **${names}**\n`;
      }
    }
    const blob = new Blob([md], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `protokoll-${new Date().toISOString().slice(0,10)}.md`;
    a.click();
    URL.revokeObjectURL(url);
    modal.querySelector('#summary-download').textContent = 'Gespeichert ✓';
  });
}

async function resetChat() {
  if (!confirm('Chat wirklich zurücksetzen?')) return;
  await fetch('/api/reset', { method: 'POST' });
}

// --- Events ---
inputEl.addEventListener('input', () => {
  updateActionBtn();
  // Auto-resize
  inputEl.style.height = 'auto';
  inputEl.style.height = Math.min(inputEl.scrollHeight, 120) + 'px';
});

inputEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    handleAction();
  }
});

topicInput.addEventListener('input', () => {
  goBtn.disabled = !topicInput.value.trim();
});

goBtn.addEventListener('click', async () => {
  const topic = topicInput.value.trim();
  if (!topic) return;
  goBtn.disabled = true;
  topicInput.disabled = true;
  await fetch('/api/message', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: topic }),
  });
});

actionBtn.addEventListener('click', handleAction);
document.getElementById('btn-action-items').addEventListener('click', generateActionItems);
document.getElementById('btn-summary').addEventListener('click', generateSummary);
document.getElementById('btn-download').addEventListener('click', downloadChat);
const feedbackBtn = document.getElementById('btn-feedback');
feedbackBtn.addEventListener('click', showFeedbackModal);
// Hide feedback button if no URL configured (will be shown/hidden after init)
pauseBtn.addEventListener('click', togglePause);
autoBtn.addEventListener('click', toggleAuto);

function showFeedbackModal() {
  document.getElementById('feedback-modal')?.remove();

  const modal = document.createElement('div');
  modal.id = 'feedback-modal';
  modal.innerHTML = `
    <div class="modal-backdrop"></div>
    <div class="modal-content" style="max-width: 480px;">
      <div class="modal-header">
        <span>💬 Feedback</span>
        <button class="modal-close">&times;</button>
      </div>
      <div class="modal-body">
        <p style="color: var(--wa-text-secondary); font-size: 13px; margin-bottom: 12px;">Was läuft gut? Was könnte besser sein? Bug gefunden?</p>
        <textarea id="feedback-text" style="width: 100%; height: 120px; padding: 10px 12px; border-radius: 8px; border: 1px solid var(--wa-border); font-family: inherit; font-size: 14px; resize: none; outline: none;" placeholder="Dein Feedback..."></textarea>
      </div>
      <div class="modal-footer">
        <button class="modal-btn" id="feedback-cancel">Abbrechen</button>
        <button class="modal-btn modal-btn-green" id="feedback-send">Absenden</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);

  const close = () => modal.remove();
  modal.querySelector('.modal-backdrop').addEventListener('click', close);
  modal.querySelector('.modal-close').addEventListener('click', close);
  modal.querySelector('#feedback-cancel').addEventListener('click', close);

  modal.querySelector('#feedback-send').addEventListener('click', async () => {
    const text = modal.querySelector('#feedback-text').value.trim();
    if (!text) return;
    const sendBtn = modal.querySelector('#feedback-send');
    sendBtn.disabled = true;
    sendBtn.textContent = 'Sende...';
    try {
      const res = await fetch(feedbackUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      const data = await res.json();
      sendBtn.textContent = data.ok ? 'Gesendet ✓' : 'Fehler';
    } catch {
      sendBtn.textContent = 'Fehler — bitte nochmal';
      sendBtn.disabled = false;
      return;
    }
    setTimeout(close, 1500);
  });

  modal.querySelector('#feedback-text').focus();
}

// --- Init ---
updateActionBtn();
connect();
