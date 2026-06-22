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

1. **Create widget component** in `frontend/src/widgets/MyWidget.tsx`
2. **Export data type** for the widget's props
3. **Register in Canvas.tsx** — add case to `renderWidget()`
4. **Add tool declaration** in `backend/src/tools.ts`
5. **Add validator** in `backend/src/validator.ts`
6. **Test** with the agent

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
