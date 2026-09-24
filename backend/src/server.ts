import 'dotenv/config';
import express from 'express';
import http from 'http';
import WebSocket, { WebSocketServer } from 'ws';
import { FunctionResponseScheduling } from '@google/genai';
import { TOOL_DECLARATIONS } from './tools.js';
import { validate, isError } from './validator.js';
import { fetchWikipediaImages } from './images.js';
import { createProvider } from './provider.js';
import { getPersona, buildSystemPrompt, listPersonas } from './personas.js';
import { execFile } from 'node:child_process';

/** Run a Python snippet locally with a hard timeout. Returns real output. */
function runPython(code: string): Promise<{ status: 'done' | 'error'; output?: string; error?: string }> {
  return new Promise((resolve) => {
    execFile(
      'python3',
      ['-c', code],
      { timeout: 8000, maxBuffer: 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          if ((err as NodeJS.ErrnoException & { killed?: boolean }).killed) {
            resolve({ status: 'error', error: 'Execution timed out (8s limit).' });
          } else {
            resolve({ status: 'error', error: (stderr || err.message || 'Execution failed').trim() });
          }
        } else {
          resolve({ status: 'done', output: stdout.trim() });
        }
      },
    );
  });
}

const PORT = Number(process.env.PORT) || 3001;
// Provider / model are config-driven; the persona drives voice + personality.
// Gemini Live flash is the default provider: free-tier, low-latency, proven.
// OpenAI Realtime slots in as a future provider without touching this file.
const PROVIDER = process.env.VOICE_PROVIDER || 'gemini';
const MODEL = process.env.VOICE_MODEL || 'gemini-2.5-flash-native-audio-preview-12-2025';
const API_KEY = process.env.GEMINI_API_KEY || '';

// Persona = identity + voice + style. SYNAPSE_PERSONA sets the default;
// a client can override it per session with ?persona= on the socket URL.
// VOICE_NAME, when set, pins the voice regardless of persona.
const DEFAULT_PERSONA = process.env.SYNAPSE_PERSONA;
const VOICE_OVERRIDE = process.env.VOICE_NAME;

// ---------------------------------------------------------------------------
// HTTP + WebSocket server
// ---------------------------------------------------------------------------
const app = express();
app.use(express.json({ limit: '2mb' }));

/**
 * Every connected browser canvas.
 *
 * The Gemini session is one way to drive the canvas, not the only one. Any
 * external agent — a coding agent, a research loop, something running in
 * another process entirely — can POST the same validated tool calls and have
 * them appear as panels. That is what makes this a surface an agent plugs
 * into rather than a feature of this particular voice loop.
 */
const canvases = new Set<WebSocket>();

function broadcast(payload: object) {
  const msg = JSON.stringify(payload);
  for (const ws of canvases) {
    if (ws.readyState === WebSocket.OPEN) {
      try { ws.send(msg); } catch { /* dropped on the next close event */ }
    }
  }
}
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/api/live' });

app.get('/health', (_req, res) => res.json({ ok: true, canvases: canvases.size }));

/**
 * Panel ingest for external agents.
 *
 *   POST /api/panel  { "name": "text_show",
 *                      "args": { "panel": "plan", "title": "Plan", "content": "..." } }
 *
 * Calls go through exactly the same validator as the voice model's, so an
 * external agent gets no more privilege over the canvas than Gemini has.
 */
app.post('/api/panel', async (req, res) => {
  const { name, args, agent } = (req.body ?? {}) as
    { name?: string; args?: Record<string, unknown>; agent?: string };
  if (typeof name !== 'string') {
    return res.status(400).json({ error: 'Body must be { name, args }.' });
  }
  const result = validate(name, args ?? {});
  if (isError(result)) return res.status(400).json({ error: result.reason });

  if (canvases.size === 0) {
    return res.status(409).json({ error: 'No canvas is connected.' });
  }

  // image_show names a subject rather than a URL, so resolve it here — an
  // external caller should not have to know how images get found.
  if (result.name === 'image_show') {
    const urls = await fetchWikipediaImages(result.args.query as string);
    broadcast({ type: 'tool_call', name: 'image_show', args: { ...result.args, urls, agent } });
    return res.json({ ok: true, images: urls.length });
  }

  // `agent` is attribution, not a tool argument — it rides alongside the
  // validated args so the panel can say who put it there.
  broadcast({ type: 'tool_call', name: result.name, args: { ...result.args, agent } });
  res.json({ ok: true });
});

// Lets the client offer the personas that actually exist rather than a
// hardcoded list that drifts out of sync with personas.ts.
app.get('/api/personas', (_req, res) => {
  res.json(listPersonas().map((p) => ({ id: p.id, label: p.label })));
});

// ---------------------------------------------------------------------------
// One voice session per browser WebSocket connection
// ---------------------------------------------------------------------------
wss.on('connection', async (browserWs, req) => {
  // Identity is fixed for the life of a Live session, so it is chosen at
  // connect time; switching persona in the UI reconnects the socket.
  canvases.add(browserWs);
  browserWs.on('close', () => canvases.delete(browserWs));

  const requested = new URL(req.url ?? '/', 'http://localhost').searchParams.get('persona');
  const persona = getPersona(requested ?? DEFAULT_PERSONA);
  const VOICE_NAME = VOICE_OVERRIDE || persona.voiceName;
  const SYSTEM_PROMPT = buildSystemPrompt(persona);
  console.log(`[proxy] Browser connected — persona="${persona.id}" voice="${VOICE_NAME}"`);

  const safeSend = (payload: object) => {
    if (browserWs.readyState === WebSocket.OPEN) {
      try {
        browserWs.send(JSON.stringify(payload));
      } catch (e) {
        console.error('[proxy] safeSend failed:', e);
      }
    }
  };

  const provider = createProvider(
    {
      provider: PROVIDER,
      model: MODEL,
      voiceName: VOICE_NAME,
      systemInstruction: SYSTEM_PROMPT,
      apiKey: API_KEY,
      tools: TOOL_DECLARATIONS,
    },
    {
      onReady: () => safeSend({ type: 'ready' }),
      onRecovered: () => safeSend({ type: 'session_recovered' }),
      onAudio: (data, mimeType) => safeSend({ type: 'audio', data, mimeType }),
      onTurnComplete: () => safeSend({ type: 'turn_complete' }),
      onOutputTranscript: (text) => safeSend({ type: 'transcript', text }),
      onInterrupted: () => safeSend({ type: 'interrupted' }),

      // Validate + execute tool calls, then answer the model in one batch.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      onToolCalls: async (functionCalls: any[]) => {
        type ToolResponse = {
          id: string;
          name: string;
          response: Record<string, unknown>;
          scheduling: FunctionResponseScheduling;
        };

        /**
         * Tool calls run CONCURRENTLY.
         *
         * They used to be awaited one after another. That was fine for a
         * single widget and badly wrong for anything compound: a Wikipedia
         * lookup chains several requests, so "show me the engine, the firing
         * order, and an explanation" serialised into tens of seconds before
         * the model heard back about any of it — and while it waits, it says
         * nothing. That is the freeze on complex questions. These calls are
         * independent and should never have been queued behind each other.
         */
        const settled = await Promise.all(
          functionCalls.map(async (fc): Promise<ToolResponse | null> => {
            try {
              const args = (fc.args ?? {}) as Record<string, unknown>;
              const result = validate(fc.name as string, args);

              if (isError(result)) {
                console.warn(`[validator] Rejected call to "${fc.name}": ${result.reason}`);
                return {
                  id: fc.id, name: fc.name,
                  response: { error: result.reason },
                  scheduling: FunctionResponseScheduling.SILENT,
                };
              }

              console.log(`[validator] Accepted: ${result.name}`, result.args);

              if (result.name === 'image_show') {
                const query = result.args.query as string;
                const urls = await fetchWikipediaImages(query);
                console.log(`[wikipedia] "${query}" panel="${result.args.panel}" → ${urls.length} candidate(s)`);
                safeSend({ type: 'tool_call', name: 'image_show', args: { ...result.args, urls } });
                return {
                  id: fc.id, name: fc.name,
                  response: urls.length
                    ? { result: 'ok', count: urls.length }
                    : { result: 'error', message: `No image found for "${query}". Try a shorter or more general query.` },
                  scheduling: FunctionResponseScheduling.SILENT,
                };
              }

              if (result.name === 'exec_python') {
                const { code, description } = result.args as { code: string; description: string };
                const execResult = await runPython(code);
                safeSend({
                  type: 'tool_call', name: 'exec_python',
                  args: { code, description, status: execResult.status, output: execResult.output, error: execResult.error },
                });
                return {
                  id: fc.id, name: fc.name,
                  response: execResult.status === 'done'
                    ? { result: 'ok', output: execResult.output }
                    : { result: 'error', message: execResult.error },
                  scheduling: FunctionResponseScheduling.SILENT,
                };
              }

              safeSend({ type: 'tool_call', name: result.name, args: result.args });
              return {
                id: fc.id, name: fc.name,
                response: { result: 'ok' },
                scheduling: FunctionResponseScheduling.SILENT,
              };
            } catch (e) {
              console.error(`[proxy] Unexpected error handling tool call "${fc.name}":`, e);
              return null;
            }
          }),
        );

        const responses = settled.filter((r): r is ToolResponse => r !== null);

        if (responses.length > 0) provider.sendToolResponse(responses);
      },

      onClosed: () => {
        safeSend({ type: 'session_closed' });
        browserWs.close();
      },
    },
  );

  try {
    await provider.connect();
  } catch (err) {
    console.error('[proxy] Failed to connect:', err);
    browserWs.close();
    return;
  }

  // --- Browser → provider ---
  browserWs.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'audio') provider.sendAudio(msg.data, msg.mimeType);
      if (msg.type === 'context') provider.sendText(msg.text as string);
    } catch (err) {
      console.error('[proxy] Bad message from browser:', err);
    }
  });

  browserWs.on('close', () => {
    console.log('[proxy] Browser disconnected');
    provider.close();
  });
});

server.listen(PORT, () => {
  console.log(`[proxy] Listening on http://localhost:${PORT}`);
});
