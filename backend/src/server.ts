import 'dotenv/config';
import express from 'express';
import http from 'http';
import WebSocket, { WebSocketServer } from 'ws';
import { GoogleGenAI, Modality, FunctionResponseScheduling } from '@google/genai';
import { TOOL_DECLARATIONS } from './tools.js';
import { validate, isError } from './validator.js';
import { fetchWikipediaImage } from './images.js';

// gemini-2.5-flash-native-audio-preview-12-2025 supports NON_BLOCKING tool calls
const MODEL = 'gemini-2.5-flash-native-audio-preview-12-2025';
const PORT = Number(process.env.PORT) || 3001;

// ---------------------------------------------------------------------------
// Gemini client — standard Gemini API (supports NON_BLOCKING tool calls)
// ---------------------------------------------------------------------------
const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY!,
});

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
- image_show — when a picture helps. Shortest accurate query, e.g. "binary search tree", "water cycle", "Colosseum". image_show replaces the previous image. If it reports an error, the picture did NOT appear — try a different, simpler query rather than claiming a picture was shown.
- code_viewer_show — whenever you show real code. Use real newlines. Add code_viewer_next_highlight(start_line, end_line) — one call per section, in order — so the code lights up as you teach.
- clear_canvas — wipes every widget, returning to the bare orb. Call it when the user switches topics or asks to clear the screen (when they explicitly ask, you MUST call it — never just say you did). If the user wants to replace ONE widget (not everything), just re-issue that widget's tool — it replaces in place; no clear needed.

After each response you receive a [canvas: ...] status line — silent metadata, never read aloud. If it says [canvas: empty] after you intended to show something, re-issue the tool call next turn.

═══ TEACHING (flexible — adapt, don't script) ═══
When someone wants to LEARN a concept: give a 3-4 sentence overview out loud while firing text_show with the structured key points, then offer to go deeper or see a code implementation — and wait. If they say yes to code: fire code_viewer_show plus the ordered highlight calls, then walk through each section as it lights up. This is a pattern, not a script — a quick factual question never needs it, and a picture request never needs a text panel first.

After any interruption: if canvas state contains "highlights cleared", re-call code_viewer_next_highlight at the start of your next response for every section you are about to discuss — highlights do not survive interruptions.`;

// ---------------------------------------------------------------------------
// Image search — see images.ts (extracted for modularity + testability)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// HTTP + WebSocket server
// ---------------------------------------------------------------------------
const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/api/live' });

app.get('/health', (_req, res) => res.json({ ok: true }));

// ---------------------------------------------------------------------------
// One Gemini session per browser WebSocket connection
// ---------------------------------------------------------------------------
wss.on('connection', async (browserWs) => {
  console.log('[proxy] Browser connected');

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let geminiSession: any = null;
  // Transparent recovery: when Gemini drops the session (rate limit,
  // timeout, transient error), the proxy silently creates a fresh one
  // on the SAME browser WebSocket — the user sees no disconnect.
  let recoveryAttempts = 0;

  const safeSend = (payload: object) => {
    if (browserWs.readyState === WebSocket.OPEN) {
      try {
        browserWs.send(JSON.stringify(payload));
      } catch (e) {
        console.error('[proxy] safeSend failed:', e);
      }
    }
  };

  const startGeminiSession = async (isRecovery: boolean) => {
    geminiSession = await ai.live.connect({
      model: MODEL,
      config: {
        responseModalities: [Modality.AUDIO],
        systemInstruction: {
          parts: [{ text: SYSTEM_PROMPT }],
        },
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: { voiceName: 'Aoede' },
          },
        },
        tools: [{ functionDeclarations: TOOL_DECLARATIONS }],
      },
      callbacks: {
        onopen: () => {
          recoveryAttempts = 0;
          console.log(`[proxy] Gemini session open${isRecovery ? ' (recovered)' : ''}`);
          safeSend({ type: isRecovery ? 'session_recovered' : 'ready' });
        },

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        onmessage: async (message: any) => {
          try {
          // --- Audio output ---
          const parts = message.serverContent?.modelTurn?.parts ?? [];
          for (const part of parts) {
            if (part.inlineData?.mimeType?.startsWith('audio/')) {
              safeSend({
                type: 'audio',
                data: part.inlineData.data,
                mimeType: part.inlineData.mimeType,
              });
            }
          }

          // --- Turn signals ---
          if (message.serverContent?.turnComplete) {
            safeSend({ type: 'turn_complete' });
          }
          if (message.serverContent?.interrupted) {
            safeSend({ type: 'interrupted' });
          }

          // --- Tool calls ---
          // All responses for a single toolCall message must be sent in ONE sendToolResponse call.
          const functionCalls = message.toolCall?.functionCalls ?? [];
          if (functionCalls.length > 0) {
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

                // image_show needs an async Wikipedia fetch before we can forward to browser
                if (result.name === 'image_show') {
                  const query = result.args.query as string;
                  const imageUrl = await fetchWikipediaImage(query);
                  console.log(`[wikipedia] query="${query}" → ${imageUrl ?? 'null'}`);
                  safeSend({ type: 'tool_call', name: 'image_show', args: { query, url: imageUrl } });
                  responses.push({
                    id: fc.id,
                    name: fc.name,
                    // Tell the model the truth: if no image was found, it must
                    // know its tool call did not produce a visual.
                    response: imageUrl
                      ? { result: 'ok', url: imageUrl }
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

            if (responses.length > 0) {
              // NON_BLOCKING + SILENT — model keeps talking uninterrupted
              try {
                Promise.resolve(
                  geminiSession.sendToolResponse({ functionResponses: responses })
                ).catch((e: unknown) => console.error(`[proxy] sendToolResponse error:`, e));
              } catch (e) {
                console.error(`[proxy] sendToolResponse threw synchronously:`, e);
              }
            }
          }
          } catch (e) {
            console.error('[proxy] Uncaught error in onmessage:', e);
          }
        },

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        onerror: (e: any) => {
          console.error('[proxy] Gemini error:', e);
        },

        onclose: () => {
          console.log('[proxy] Gemini session closed');
          if (browserWs.readyState !== WebSocket.OPEN) return;
          // Transparent recovery: recreate the Gemini session on this same
          // browser connection instead of dropping it. Only after repeated
          // failures do we signal the browser (whose own auto-reconnect
          // then takes over as a last resort).
          if (recoveryAttempts >= 3) {
            console.log('[proxy] recovery attempts exhausted — closing browser WS');
            safeSend({ type: 'session_closed' });
            browserWs.close();
            return;
          }
          recoveryAttempts += 1;
          const delay = Math.min(1500 * 2 ** (recoveryAttempts - 1), 8000);
          console.log(`[proxy] recovering Gemini session in ${delay}ms (attempt ${recoveryAttempts}/3)`);
          setTimeout(() => {
            if (browserWs.readyState !== WebSocket.OPEN) return;
            startGeminiSession(true).catch((err) => {
              console.error('[proxy] recovery connect failed:', err);
              safeSend({ type: 'session_closed' });
              browserWs.close();
            });
          }, delay);
        },
      },
    });
  };

  try {
    await startGeminiSession(false);
  } catch (err) {
    console.error('[proxy] Failed to connect to Gemini:', err);
    browserWs.close();
    return;
  }

  // --- Browser → Gemini ---
  browserWs.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());

      if (msg.type === 'audio' && geminiSession) {
        geminiSession.sendRealtimeInput({
          audio: {
            data: msg.data,
            mimeType: msg.mimeType ?? 'audio/pcm;rate=16000',
          },
        });
      }

      if (msg.type === 'context' && geminiSession) {
        geminiSession.sendRealtimeInput({ text: msg.text as string });
      }
    } catch (err) {
      console.error('[proxy] Bad message from browser:', err);
    }
  });

  browserWs.on('close', () => {
    console.log('[proxy] Browser disconnected');
    try { geminiSession?.close?.(); } catch (_) { /* ignore */ }
  });
});

server.listen(PORT, () => {
  console.log(`[proxy] Listening on http://localhost:${PORT}`);
});
