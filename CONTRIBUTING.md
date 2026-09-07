# Contributing to Synapse

Thank you for your interest in making Synapse better!

## Development Setup

```bash
git clone https://github.com/RishvanthAmsaraj/Synapse.git
cd Synapse
npm install
```

## Project Structure

```
Synapse/
├── frontend/          # React + Vite frontend
├── backend/           # Node.js + Express backend
├── package.json       # Workspace root
└── README.md
```

## Running Locally

```bash
# Copy environment template
cp backend/.env.example backend/.env
# Add your GEMINI_API_KEY to backend/.env

# Start both frontend and backend
npm run dev

# Or start individually:
npm run dev:frontend
npm run dev:backend
```

## Adding a New Widget

The widget SDK is declarative — three steps, no parallel lists to keep in sync:

1. **Create the component** in `frontend/src/widgets/MyWidget.tsx` (takes `{ data }`).
2. **Register it** in `frontend/src/widgets/registry.ts` (type → component + default grid span).
3. **Add a `ToolSpec`** in `backend/src/tools.ts` (name, widgetType, description, params).

The Gemini tool declaration **and** the validator spec are generated automatically
from the `ToolSpec`; `Canvas.tsx` renders from the registry. No switch statement or
validator entry to edit.

## Code Style

- TypeScript for all new code
- Functional React components with hooks
- Explicit types over `any`
- Comments for complex logic

## Submitting Changes

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Test thoroughly
5. Submit a pull request

## Questions?

Open an issue or reach out to the maintainers.
