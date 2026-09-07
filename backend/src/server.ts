import 'dotenv/config';
import express from 'express';
import http from 'http';
import WebSocket, { WebSocketServer } from 'ws';
import { FunctionResponseScheduling } from '@google/genai';
import { TOOL_DECLARATIONS } from './tools.js';
import { validate, isError } from './validator.js';
import { fetchWikipediaImages } from './images.js';
import { createProvider } from './provider.js';
import { getPersona, buildSystemPrompt } from './personas.js';
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

// Persona = identity + voice + style. SYNAPSE_PERSONA selects (companion |
// teacher | assistant). VOICE_NAME overrides the persona's default voice.
const persona = getPersona(process.env.SYNAPSE_PERSONA);
const VOICE_NAME = process.env.VOICE_NAME || persona.voiceName;
const SYSTEM_PROMPT = buildSystemPrompt(persona);

// ---------------------------------------------------------------------------
// HTTP + WebSocket server
// ---------------------------------------------------------------------------
const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/api/live' });

app.get('/health', (_req, res) => res.json({ ok: true }));

// ---------------------------------------------------------------------------
// One voice session per browser WebSocket connection
// ---------------------------------------------------------------------------
wss.on('connection', async (browserWs) => {
  console.log('[proxy] Browser connected');

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
      onInterrupted: () => safeSend({ type: 'interrupted' }),

      // Validate + execute tool calls, then answer the model in one batch.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      onToolCalls: async (functionCalls: any[]) => {
        const responses: Array<{
          id: string;
          name: string;
          response: Record<string, unknown>;
          scheduling: FunctionResponseScheduling;
        }> = [];

        for (const fc of functionCalls) {
          try {
            const args = (fc.args ?? {}) as Record<string, unknown>;
            const result = validate(fc.name as string, args);

            if (isError(result)) {
              console.warn(`[validator] Rejected call to "${fc.name}": ${result.reason}`);
              responses.push({
                id: fc.id,
                name: fc.name,
                response: { error: result.reason },
                scheduling: FunctionResponseScheduling.SILENT,
              });
              continue;
            }

            console.log(`[validator] Accepted: ${result.name}`, result.args);

            if (result.name === 'image_show') {
              const query = result.args.query as string;
              const urls = await fetchWikipediaImages(query);
              console.log(`[wikipedia] query="${query}" → ${urls.length} candidate(s)`);
              safeSend({ type: 'tool_call', name: 'image_show', args: { query, urls } });
              responses.push({
                id: fc.id,
                name: fc.name,
                response: urls.length
                  ? { result: 'ok', count: urls.length }
                  : { result: 'error', message: `No image found for "${query}". Try a shorter or more general query.` },
                scheduling: FunctionResponseScheduling.SILENT,
              });
            } else if (result.name === 'exec_python') {
              const { code, description } = result.args as { code: string; description: string };
              const execResult = await runPython(code);
              safeSend({
                type: 'tool_call',
                name: 'exec_python',
                args: { code, description, status: execResult.status, output: execResult.output, error: execResult.error },
              });
              responses.push({
                id: fc.id,
                name: fc.name,
                response:
                  execResult.status === 'done'
                    ? { result: 'ok', output: execResult.output }
                    : { result: 'error', message: execResult.error },
                scheduling: FunctionResponseScheduling.SILENT,
              });
            } else {
              safeSend({ type: 'tool_call', name: result.name, args: result.args });
              responses.push({
                id: fc.id,
                name: fc.name,
                response: { result: 'ok' },
                scheduling: FunctionResponseScheduling.SILENT,
              });
            }
          } catch (e) {
            console.error(`[proxy] Unexpected error handling tool call "${fc.name}":`, e);
          }
        }

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
