# Synapse

**A modular, voice-first AI interaction framework with a Concurrent Multimodal Stream Architecture (CMSA).**

Synapse enables AI agents to communicate through voice while simultaneously manipulating a visual canvas of interactive widgets — **all at the same time**. Powered by the Synapse Parallel Processing Engine (SPPE), it introduces a novel approach to multi-stream dependency scheduling that lets LLMs speak, show images, execute code, and animate widgets concurrently.

Designed by [Rishvanth Amsaraj](https://github.com/RishvanthAmsaraj).

## 🎯 Vision

Current AI interfaces force users to choose between:
- **Text chat** (slow, limited context)
- **Voice conversation** (no visual aids)
- **Code generation** (sequential, one thing at a time)

**Synapse solves this by introducing true simultaneity — a capability no existing system provides:**
- 🎙️ **Voice-first** — Natural conversation through speech
- 🎨 **Visual canvas** — Dynamic widgets that appear as needed
- ⚡ **Real-time** — Agent speaks while generating content
- 🔄 **Parallel execution** — Multiple streams operate concurrently with transactional guarantees

## ✨ Innovation: SPPE (Synapse Parallel Processing Engine)

SPPE is a first-of-its-kind concurrent stream coordinator that enables LLMs to act on multiple fronts simultaneously. It's inspired by cutting-edge research from GAP (Graph-Based Agent Planning, arXiv:2510.25320) and Atomix (Timely Transactional Tool Use, arXiv:2602.14849), with novel innovations in multi-stream dependency scheduling and barge-in compensation.

**Key capabilities:**

| Feature | GAP | Atomix | ChatGPT Voice | Synapse (SPPE) |
|---------|-----|--------|---------------|-----------------|
| Parallel tool calls | ✅ DAG-based | ✅ Transactional | ❌ | ✅ **Multi-stream** |
| Speech + visuals | ❌ | ❌ | ❌ | ✅ **Native** |
| Transactional rollback | ❌ | ✅ | ❌ | ✅ **Barge-in compensation** |
| Background code execution | ❌ | ❌ | ❌ | ✅ **Sandboxed streams** |
| Frontier-based scheduling | ❌ | ✅ frontiers | ❌ | ✅ **+ DAG dependency** |
| Stream merge | ❌ | ❌ | ❌ | ✅ |

### Three Concurrent Streams

```
Stream A (Speech): ───⌇──────⌇──────⌇──────→  (the model speaking)
                    │      │      │
Stream B (Widget):  ──text─┘      │
                    ───image───────┘
                    ──────code──────⌇────→
                                    │
Stream C (Exec):    ──execute───────┘─────→
```

- **Independent** actions fire together (text + image + speech)
- **Sequential** actions respect order (code_viewer_show → highlights)
- **Data-dependent** actions wait for results (exec → consume)
- **Frontier tracking** prevents race conditions across streams

## 📚 Research Foundation

See [docs/research-parallel-processing-engine.md](docs/research-parallel-processing-engine.md) for the full research analysis and architectural details.

## 🎨 Design Language

Synapse matches the premium design language of the broader suite of tools:
- **Orange accent** (#ff6200), Poppins typography
- Dark/light mode with CSS custom properties
- Card-based layout with clean surfaces
- Smooth transitions and subtle shadows

## 🏗️ Architecture

```
┌─────────────────────────────────────────┐
│           Frontend (React)               │
│  ┌─────────┐  ┌─────────┐  ┌────────┐ │
│  │  Voice  │  │ Canvas  │  │ Widgets│ │
│  │ Capture │  │ Manager │  │ (Plugs)│ │
│  └────┬────┘  └────┬────┘  └───┬────┘ │
│       │            │           │      │
│       └────────────┴───────────┘      │
│                   │                    │
│              WebSocket                 │
└───────────────────┬─────────────────────┘
                    │
┌───────────────────┼─────────────────────┐
│           Backend (Node/Express)         │
│                   │                      │
│  ┌────────────────┴────────────────┐   │
│  │      Gemini Live API Proxy       │   │
│  │  ┌─────────┐    ┌────────────┐  │   │
│  │  │  Audio  │◄──►│  Tool Call │  │   │
│  │  │ Stream  │    │  Handler   │  │   │
│  │  └─────────┘    └────────────┘  │   │
│  └─────────────────────────────────┘   │
└─────────────────────────────────────────┘
```

## 🚀 Quick Start

### Prerequisites
- Node.js 18+
- Google Gemini API key

### Installation

```bash
# Clone the repository
git clone https://github.com/RishvanthAmsaraj/Synapse.git
cd Synapse

# Install dependencies
npm install

# Set up environment
cp backend/.env.example backend/.env
# Edit backend/.env and add your GEMINI_API_KEY

# Start development server
npm run dev
```

The application will be available at `http://localhost:5173`

## 🎨 Widget System

Widgets are the building blocks of the Synapse canvas. Each widget is a self-contained React component that can be dynamically instantiated by the AI agent.

### Current Widgets

| Widget | Purpose | Tool Call |
|--------|---------|-----------|
| **CodeViewer** | Display and highlight code | `code_viewer_show` |
| **TextWidget** | Markdown text blocks | `text_show` |
| **ImageWidget** | Display images/diagrams | `image_show` |
| **CallStack** | Visualize function calls | `call_stack_show` |

### Widget Protocol

Widgets communicate through a standardized interface:

```typescript
interface Widget {
  id: string;
  type: string;
  data: unknown;
  cols: number;  // Grid column span (1-3)
  rows: number;  // Grid row span (1-2)
}
```

### Creating Custom Widgets

```typescript
// 1. Define your widget data type
export interface MyWidgetData {
  title: string;
  content: string;
}

// 2. Create the component
export function MyWidget({ data }: { data: MyWidgetData }) {
  return <div>{data.title}: {data.content}</div>;
}

// 3. Register in Canvas.tsx
function renderWidget(type: string, data: unknown) {
  switch (type) {
    case 'my_widget':
      return <MyWidget data={data as MyWidgetData} />;
    // ...
  }
}

// 4. Add tool declaration in backend/src/tools.ts
{
  name: 'my_widget_show',
  description: 'Display my custom widget',
  behavior: Behavior.NON_BLOCKING,
  parameters: {
    type: Type.OBJECT,
    properties: {
      title: { type: Type.STRING },
      content: { type: Type.STRING },
    },
    required: ['title', 'content'],
  },
}
```

## 🔌 Agent Integration

Synapse uses Google's Gemini Live API with function calling to enable real-time voice interaction with visual tool use.

### Key Features

- **NON_BLOCKING tool calls** — Agent continues speaking while tools execute
- **Simultaneous actions** — Multiple tools can fire at once
- **Context awareness** — Canvas state is injected back into the model
- **Interruption handling** — Clean state reset on user barge-in

### System Prompt Engineering

The system prompt (in `backend/src/server.ts`) is carefully crafted to:
1. **Enforce silent tool use** — Agent never announces tool calls
2. **Structure teaching** — Three-phase: Overview → Offer → Walkthrough
3. **Handle interruptions** — Re-issue highlights after barge-in
4. **Maintain flow** — Speech continues naturally during visual updates

## 🛠️ Tech Stack

### Frontend
- **React 18** — UI framework
- **Vite** — Build tool
- **Web Audio API** — Audio capture/playback
- **WebSocket** — Real-time communication

### Backend
- **Node.js + Express** — HTTP server
- **WebSocket (ws)** — Bidirectional communication
- **Google GenAI SDK** — Gemini Live API integration
- **TypeScript** — Type safety

### Audio Pipeline
- **Input**: 16kHz PCM via AudioWorklet
- **Output**: 24kHz PCM with gapless playback
- **Format**: Base64-encoded Int16 PCM

## 📁 Project Structure

```
Synapse/
├── frontend/
│   ├── src/
│   │   ├── canvas/           # Canvas management
│   │   │   ├── Canvas.tsx
│   │   │   └── CanvasProvider.tsx
│   │   ├── hooks/            # React hooks
│   │   │   ├── useAudioIO.ts      # Microphone capture
│   │   │   ├── useAudioPlayback.ts # Audio output
│   │   │   └── useLiveSession.ts  # WebSocket session
│   │   ├── widgets/          # Widget components
│   │   │   ├── CodeViewer.tsx
│   │   │   ├── TextWidget.tsx
│   │   │   ├── ImageWidget.tsx
│   │   │   └── CallStack.tsx
│   │   └── App.tsx           # Main application
│   └── public/worklets/      # AudioWorklet processors
├── backend/
│   └── src/
│       ├── server.ts         # HTTP/WebSocket server
│       ├── tools.ts          # Tool declarations
│       └── validator.ts      # Input validation
└── package.json
```

## 🎓 Teaching Mode

Synapse includes a structured teaching pattern for educational content:

### Phase 1: Overview
- Display text summary with key points
- Show relevant image/diagram
- Provide spoken introduction

### Phase 2: Offer
- Ask if user wants code walkthrough
- Wait for verbal confirmation

### Phase 3: Walkthrough
- Display code with syntax highlighting
- Highlight sections sequentially
- Explain each section while highlighting

## 🔮 Future Roadmap

### Widgets
- [ ] **WhiteboardWidget** — Freeform drawing canvas
- [ ] **ChartWidget** — Data visualization (charts/graphs)
- [ ] **VideoWidget** — Embed YouTube/video content
- [ ] **BrowserWidget** — Live webpage preview
- [ ] **TerminalWidget** — Interactive command line
- [ ] **DiffWidget** — Side-by-side code comparison

### Features
- [ ] **Multi-agent support** — Switch between different AI models
- [ ] **Session persistence** — Save and resume conversations
- [ ] **Widget animations** — Smooth transitions and movements
- [ ] **Voice selection** — Multiple voice options for agent
- [ ] **Language support** — Multi-language teaching
- [ ] **Collaborative mode** — Multiple users, one canvas

### Protocol Improvements
- [ ] **Widget API** — Standardized widget communication protocol
- [ ] **Streaming tools** — Progressive widget updates
- [ ] **Tool composition** — Chain multiple tools together
- [ ] **Context windows** — Better state management for long sessions

## 🤝 Contributing

We welcome contributions! See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

### Development Setup

```bash
# Frontend only
npm run dev:frontend

# Backend only
npm run dev:backend

# Both (concurrent)
npm run dev
```

## 📄 License

All Rights Reserved — see [LICENSE](LICENSE) for details.

## 🙏 Acknowledgments

- Google Gemini team for the Live API
- React and Vite communities
- All contributors and testers

---

**Synapse** — *Making AI interactions more human, one voice at a time.*
