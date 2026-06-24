# Synapse Roadmap

## Current State (v2.0 — CMSA + SPPE)

Synapse introduces the **Concurrent Multimodal Stream Architecture (CMSA)**:
- ✅ Real-time voice conversation with Gemini
- ✅ Dynamic widget canvas (code, text, image, call stack)
- ✅ NON_BLOCKING tool calls for simultaneous speech + visuals
- ✅ SPPE runtime (Synapse Parallel Processing Engine) for transactional scheduling
- ✅ Dependency-aware multi-stream coordination (independent / sequential / data_dependent / merge)
- ✅ Frontier-based version tracking for widget state
- ✅ Barge-in compensation (Atomix-inspired rollback)
- ✅ Design language matching CalculatorRA / QuantBot / RAG Assistant
- ✅ Dark/light theme with orange (#ff6200) accent
- ✅ Debug log panel with SPPE event coloring

## Phase 1: SPPE Expansion

### New Streams
- [x] **Exec stream** — Action scheduling and tool declarations
- [ ] **Exec sandbox** — Backend Python/JS execution (Pyodide / WebAssembly)
- [ ] **Terminal widget** — Interactive shell session with xterm.js
- [ ] **Caption overlay** — Real-time transcription display

### SPPE Features
- [x] **DAG visualization** — Debug panel shows the live dependency graph
- [ ] **Conflict resolution UI** — Visual indicators with resolution timeline
- [x] **Stream waterfall** — Timeline view of all three streams
- [x] **Frontier dashboard** — Real-time frontier version display
- [x] **Exec stream routing** — SPPE schedules exec actions as independent stream
- [x] **Terminal widget** — Code/output/error display with status indicators

## Phase 2: New Widgets

### High Priority
- [ ] **ChartWidget** — Live-updating charts via Chart.js
- [ ] **TerminalWidget** — xterm.js with interactive shell
- [ ] **WhiteboardWidget** — Freeform drawing with SVG/Canvas
- [ ] **FileWidget** — File explorer/preview

### Medium Priority
- [ ] **DiffWidget** — Side-by-side code comparison
- [ ] **MathWidget** — KaTeX equation rendering
- [ ] **MapWidget** — Leaflet geographic visualization
- [ ] **VideoWidget** — Embed with timestamp control

### Widget Improvements
- [ ] **Drag-and-drop** — Reorder widgets on canvas
- [ ] **Resize handles** — Adjust widget dimensions
- [ ] **Minimize/maximize** — Collapse widgets to save space
- [ ] **Widget tabs** — Group related widgets
- [ ] **Animations** — Smooth enter/exit transitions

## Phase 3: Multi-Agent Support

### Agent Integration
- [ ] **OpenAI integration** — GPT-4o with real-time voice
- [ ] **Anthropic integration** — Claude with tool use
- [ ] **Local models** — Ollama/Llama.cpp support
- [ ] **Agent switching** — Change mid-conversation
- [ ] **Agent personas** — Different voices/personalities

### SPPE Multi-Agent
- [ ] **Per-agent streams** — Each agent gets its own stream set
- [ ] **Shared canvas** — Multiple agents share the same canvas
- [ ] **Agent → Agent messaging** — Stream-based inter-agent communication

### Protocol Standardization
- [ ] **Widget API spec** — Standard interface for all widgets
- [ ] **Tool call schema** — JSON Schema for validation
- [ ] **Session protocol** — State synchronization standard

## Phase 4: Advanced Features

### Collaboration
- [ ] **Multi-user sessions** — Multiple users, one canvas
- [ ] **Screen sharing** — Share canvas via WebRTC
- [ ] **Session recording** — Save and replay conversations
- [ ] **Annotations** — Draw on widgets collaboratively

### Intelligence
- [ ] **Context memory** — Long-term conversation memory
- [ ] **Knowledge base** — RAG for domain-specific content
- [ ] **Code execution** — Safe sandbox (Pyodide / WebAssembly)
- [ ] **File upload** — Drag-and-drop file analysis

### Accessibility
- [ ] **Captions** — Real-time speech-to-text display
- [ ] **Voice selection** — Multiple TTS voices
- [ ] **Language support** — i18n for UI and speech
- [ ] **Keyboard shortcuts** — Full keyboard navigation

## Phase 5: Platform Expansion

### Deployment
- [ ] **Desktop app** — Electron/Tauri wrapper
- [ ] **Mobile app** — React Native or PWA
- [ ] **Cloud hosting** — One-click deploy to Vercel/Render
- [ ] **Self-hosted** — Docker compose setup

### Integrations
- [ ] **VS Code extension** — Code editor integration with Synapse canvas
- [ ] **Slack/Discord bot** — Chat platform integration
- [ ] **Notion/Obsidian** — Note-taking integration
- [ ] **GitHub** — Code review assistance

## Long-term Vision

**Synapse as the universal AI interface:**
- Any model, any widget, any platform
- True parallel multi-modal communication (no other system does this)
- SPPE as the standard runtime for concurrent agent-stream coordination
- Open protocol for the AI interaction layer

---

**What makes Synapse unique:** No existing system (ChatGPT Voice, Claude, Gemini Live, Cursor, Copilot) combines real-time speech with visual canvas updates AND background code execution — all simultaneously, with transactional guarantees. This is a genuine first in the industry.

Want to contribute? Check [CONTRIBUTING.md](CONTRIBUTING.md) and pick an item from the roadmap!
