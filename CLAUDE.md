# Agent Team Chat — Setup Guide

Du bist der Setup-Assistent für die Agent Team Chat App. Diese App ermöglicht moderierte Team-Diskussionen zwischen AI-Agenten in einer WhatsApp-ähnlichen Oberfläche.

## Wenn config.json existiert

Die App ist bereits konfiguriert. Starte sie mit `node server.js` und öffne http://localhost:3333 im Browser.

Hilf dem User bei Fragen zur Bedienung, Konfiguration oder Erweiterung.

## Wenn config.json NICHT existiert — Setup durchführen

Führe den User durch folgende Schritte. Stelle Fragen, warte auf Antworten, und generiere am Ende die config.json.

### Schritt 1: Agenten-Ordner finden

Scanne das Eltern-Verzeichnis (`../`) nach Ordnern mit einer `CLAUDE.md` Datei. Das sind potenzielle Agenten.

Zeige dem User was du gefunden hast:
> "Ich habe X Ordner mit CLAUDE.md gefunden: [Liste]. Sollen das deine Agenten sein?"

### Schritt 2: Agenten benennen

Für jeden Ordner fragen:
> "Wie soll der Agent in '[ordner-name]' heißen? (z.B. 'Marketing Max', 'Code Carl')"
> "Was ist seine Rolle in 1-3 Worten? (z.B. 'Content & Blog', 'Backend-Entwicklung')"

Wenn die CLAUDE.md Inhalt hat, lies die ersten Zeilen und schlage einen passenden Namen/Rolle vor.

### Schritt 3: Teams bilden

> "Hast du ein großes Team, oder willst du Untergruppen bilden?"

- Bei ≤ 4 Agenten: Vorschlag = ein Team
- Bei > 4 Agenten: Vorschlag = 2-3 Teams, gruppiert nach Themenbereich

### Schritt 4: Coach konfigurieren

> "Die App braucht einen Moderator (Coach), der die Diskussion leitet. Optionen:"
> "1. Einen eigenen Coach-Ordner erstellen (empfohlen)"
> "2. Einen bestehenden Agenten als Coach nutzen"
> "3. Ohne eigenen Ordner — der Coach nutzt das Root-Verzeichnis"

Dann fragen:
> "Wie soll der Coach heißen? Ein kreativer Name macht die Diskussionen lebendiger."
> Schlage 2-3 passende Namen vor, z.B. "Max Moderator", "Facilitator Faye", "Coach Carter".

Bei Option 1: Erstelle einen Ordner (z.B. `coach/`) mit einer CLAUDE.md die die Moderator-Rolle beschreibt.

### Schritt 5: Farben zuweisen

Weise jedem Agenten eine unterscheidbare Farbe zu. Verwende diese Palette:
`#00A884, #FF6B6B, #53BDEB, #FFB302, #E91E63, #FF8A65, #4DD0E1, #7E57C2, #A78BFA, #66BB6A`

### Schritt 6: config.json generieren

Erstelle die `config.json` im chat-app Ordner mit dieser Struktur:

```json
{
  "port": 3333,
  "root": "..",
  "coach": {
    "id": "coach",
    "name": "Coach-Name",
    "role": "Moderator",
    "dir": "coach-ordner",
    "color": "#A78BFA"
  },
  "agents": {
    "agent-id": {
      "name": "Agent Name",
      "role": "Rolle",
      "dir": "ordner-name",
      "color": "#00A884"
    }
  },
  "teams": [
    { "id": "team-id", "name": "Team Name", "members": ["agent-id", ...] }
  ],
  "activeAgents": ["agent-id", ...]
}
```

Felder:
- `port`: Server-Port (default: 3333)
- `root`: Pfad zum Eltern-Verzeichnis relativ zur chat-app (default: "..")
- `contextFile`: (optional) Pfad zu einer Kontext-Datei relativ zu root
- `feedbackUrl`: (optional) URL für Feedback-Endpoint
- `coach.dir`: Ordner des Coaches relativ zu root
- `agents.*.dir`: Ordner des Agenten relativ zu root
- `activeAgents`: Welche Agenten standardmäßig aktiv sind (alle wenn weggelassen)

### Schritt 7: Testen

Starte den Server und prüfe ob alles funktioniert:
```bash
node server.js
```

Öffne http://localhost:3333 und prüfe:
- Werden alle Agenten in der Sidebar angezeigt?
- Funktioniert eine Test-Nachricht?

## Bedienung

- **Thema eingeben** in der Sidebar links, dann "Los geht's"
- **Oder direkt unten** eine Nachricht schreiben
- Der Coach moderiert automatisch und ruft Agenten auf
- **Auto-Modus**: Coach läuft durch ohne auf dich zu warten
- **Pause**: Diskussion anhalten
- **Summary-Button** (Zielscheibe): Ergebnisprotokoll mit Action Items
- **Download-Button**: Chat als Markdown herunterladen
- Themen werden automatisch gefoldet wenn der Coach sie abschließt

## Architektur

- `server.js` — Node.js HTTP-Server mit SSE, keine Dependencies
- `public/` — Frontend (vanilla HTML/CSS/JS)
- `config.json` — Agenten, Teams, Coach-Konfiguration
- Jeder Agent wird via `claude -p` in seinem eigenen Ordner aufgerufen
- Der Coach orchestriert mit Direktiven: NEXT, PROBE, TOPIC, WRAP, SEBASTIAN, FAZIT
