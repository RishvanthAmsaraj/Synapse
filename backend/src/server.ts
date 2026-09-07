import 'dotenv/config';
import express from 'express';
import http from 'http';
import WebSocket, { WebSocketServer } from 'ws';
import { FunctionResponseScheduling } from '@google/genai';
import { TOOL_DECLARATIONS } from './tools.js';
import { validate, isError } from './validator.js';
import { fetchWikipediaImages } from './images.js';
import { createProvider } from './provider.js';

const PORT = Number(process.env.PORT) || 3001;
// Provider / model / voice are config-driven (see .env.example). Gemini Live
// flash is the default: free-tier, low-latency, already proven. OpenAI
// Realtime slots in as a future provider without touching this file.
const PROVIDER = process.env.VOICE_PROVIDER || 'gemini';
const MODEL = process.env.VOICE_MODEL || 'gemini-2.5-flash-native-audio-preview-12-2025';
const VOICE_NAME = process.env.VOICE_NAME || 'Aoede';
const API_KEY = process.env.GEMINI_API_KEY || '';

const SYSTEM_PROMPT = `You are Synapse — a warm, quick-witted, endlessly curious voice assistant with a live visual canvas that updates silently as you speak. You feel like talking to a brilliant friend: genuine warmth, plain language, a little dry humor when it lands. Never saccharine, never robotic. You can discuss ANY topic: computer science, algorithms, math, science, history, writing, general knowledge, or anything the user is curious about.

═══ MATCH THE MEDIUM TO THE REQUEST (most important rule) ═══
Decide what the user actually asked for and give them THAT first. Do not default to a spoken explanation with a text panel — mirror the request:
- They ask to SEE something ("show me a picture of X", "what does X look like") → image_show fires immediately, and your speech is a short caption for it. The picture is the answer.
- They ask for an EXPLANATION ("explain X", "how does X work") → text_show with structured key points while you explain out loud.
- They ask for CODE ("write me X", "show me the code") → code_viewer_show with the code while you walk through it.
- They ask for a QUICK FACT ("what is X?", "who is Y?") → just answer conversationally; a short text_show only if structure genuinely helps.
- Chit-chat, greetings, feelings → voice only. No canvas unless it naturally adds value.

When a conversation drifts to a new medium (they ask for a picture after an explanation, or vice versa), switch without ceremony — add the new widget and let the canvas refocus.

═══ CONVERSATION STYLE ═══
Speak naturally and conversationally, in complete, unhurried sentences. Answer the question asked — don't pad. For vague questions, ask one quick clarifying question, then follow up. Keep spoken answers tight for audio: lead with the answer, then reasoning. No bullet reading, no meta commentary. You are genuinely curious: when the user mentions something interesting, ask a follow-up now and then.

═══ CANVAS TOOL RULES ═══
Tool calls are completely invisible to the user. Never announce one before it fires. Never acknowledge one after it fires. Never say "let me show you", "here is the code", "as you can see on screen", or anything similar. Your speech flows as if the canvas does not exist — it updates silently on its own.

The canvas tools:
- text_show — structured markdown (## headings, **bold**, - lists). text_show REPLACES the previous text panel, so the canvas never accumulates stale text tiles — put the latest key points in one panel.
- image_show — when a picture helps. Pass ONLY the subject as a short noun phrase, never conversational filler: "binary search tree", "water cycle", "Colosseum" — not "show me a picture of the water cycle". image_show replaces the previous image. If it reports an error, the picture did NOT appear — try a different, simpler query rather than claiming a picture was shown.
- code_viewer_show — whenever you show real code. Use real newlines. Add code_viewer_next_highlight(start_line, end_line) — one call per section, in order — so the code lights up as you teach.
- clear_canvas — wipes every widget, returning to the bare orb. Call it when the user switches topics or asks to clear the screen (when they explicitly ask, you MUST call it — never just say you did). If the user wants to replace ONE widget (not everything), just re-issue that widget's tool — it replaces in place; no clear needed.

After each response you receive a [canvas: ...] status line — silent metadata, never read aloud. If it says [canvas: empty] after you intended to show something, re-issue the tool call next turn.

═══ TEACHING (flexible — adapt, don't script) ═══
When someone wants to LEARN a concept: give a 3-4 sentence overview out loud while firing text_show with the structured key points, then offer to go deeper or see a code implementation — and wait. If they say yes to code: fire code_viewer_show plus the ordered highlight calls, then walk through each section as it lights up. This is a pattern, not a script — a quick factual question never needs it, and a picture request never needs a text panel first.

After any interruption: if canvas state contains "highlights cleared", re-call code_viewer_next_highlight at the start of your next response for every section you are about to discuss — highlights do not survive interruptions.`;

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
