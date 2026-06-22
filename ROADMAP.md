# Synapse Roadmap

## Current State

Synapse is a voice-first AI interaction framework with:
- Real-time voice conversation with Gemini
- Dynamic widget canvas (code, text, image, call stack)
- NON_BLOCKING tool calls for simultaneous speech + visuals
- Structured teaching mode for educational content

## Phase 1: Core Stability (Current)

### Improvements Needed
- [ ] **Error handling** — Better recovery from API failures
- [ ] **State management** — Centralized state for complex sessions
- [ ] **Widget lifecycle** — Proper cleanup and memory management
- [ ] **Reconnection logic** — Auto-reconnect on WebSocket drop
- [ ] **Audio robustness** — Handle browser audio permission changes

## Phase 2: Widget Ecosystem

### New Widgets
- [ ] **WhiteboardWidget** — Freeform drawing with SVG/Canvas
- [ ] **ChartWidget** — Charts.js or D3.js integration
- [ ] **VideoWidget** — YouTube/video embed with timestamp control
- [ ] **BrowserWidget** — iframe with URL navigation
- [ ] **TerminalWidget** — xterm.js for interactive shell
- [ ] **DiffWidget** — Side-by-side code comparison
- [ ] **MathWidget** — KaTeX for equation rendering
- [ ] **MapWidget** — Leaflet for geographic visualization

### Widget Improvements
- [ ] **Drag-and-drop** — Reorder widgets on canvas
- [ ] **Resize handles** — Adjust widget dimensions
- [ ] **Minimize/maximize** — Collapse widgets to save space
- [ ] **Widget tabs** — Group related widgets
- [ ] **Animations** — Smooth enter/exit transitions

## Phase 3: Multi-Agent Support

### Agent Integration
- [ ] **OpenAI integration** — GPT-4o with voice
- [ ] **Anthropic integration** — Claude with tool use
- [ ] **Local models** — Ollama/Llama.cpp support
- [ ] **Agent switching** — Change mid-conversation
- [ ] **Agent personas** — Different voices/personalities

### Protocol Standardization
- [ ] **Widget API spec** — Standard interface for all widgets
- [ ] **Tool call schema** — JSON Schema for validation
- [ ] **Session protocol** — State synchronization standard
- [ ] **Audio format** — Standardized PCM streaming

## Phase 4: Advanced Features

### Collaboration
- [ ] **Multi-user sessions** — Multiple users, one canvas
- [ ] **Screen sharing** — Share canvas via WebRTC
- [ ] **Session recording** — Save and replay conversations
- [ ] **Annotations** — Draw on widgets collaboratively

### Intelligence
- [ ] **Context memory** — Long-term conversation memory
- [ ] **Knowledge base** — RAG for domain-specific content
- [ ] **Code execution** — Safe sandbox for running code
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
- [ ] **VS Code extension** — Code editor integration
- [ ] **Slack/Discord bot** — Chat platform integration
- [ ] **Notion/Obsidian** — Note-taking integration
- [ ] **GitHub** — Code review assistance

## Long-term Vision

**Synapse as the universal AI interface:**
- Any model, any widget, any platform
- Natural voice interaction with rich visuals
- Truly simultaneous multi-modal communication
- Open protocol for the AI interaction layer

---

Want to contribute? Check [CONTRIBUTING.md](CONTRIBUTING.md) and pick an item from the roadmap!
