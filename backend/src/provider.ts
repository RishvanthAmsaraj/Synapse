// ---------------------------------------------------------------------------
// Voice provider abstraction — the backend speaks to a voice model through a
// single interface, so Gemini Live (default, free-tier) and OpenAI Realtime
// (premium smoothness) are swappable behind the same wall. server.ts only
// knows this interface; adding a provider means adding one class + a case in
// createProvider, nothing else.
// ---------------------------------------------------------------------------

import { GoogleGenAI, Modality } from '@google/genai';

// Config assembled from env + persona + tool declarations.
export interface VoiceProviderConfig {
  provider: string;           // 'gemini' (default) | future: 'openai'
  model: string;
  voiceName: string;
  systemInstruction: string;
  apiKey: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tools: any[];               // FunctionDeclaration[]
}

// Events the provider emits upward to the transport layer (server.ts).
export interface VoiceProviderCallbacks {
  onReady: () => void;
  onRecovered: () => void;
  onAudio: (data: string, mimeType: string) => void;
  onTurnComplete: () => void;
  onInterrupted: () => void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onToolCalls: (functionCalls: any[]) => void;
  onClosed: () => void;       // recovery exhausted — signal the client to reconnect
}

export interface VoiceProvider {
  connect(): Promise<void>;
  sendAudio(data: string, mimeType: string): void;
  sendText(text: string): void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sendToolResponse(responses: any[]): void;
  close(): void;
}

// ---------------------------------------------------------------------------
// Gemini Live implementation
// ---------------------------------------------------------------------------

class GeminiLiveProvider implements VoiceProvider {
  private ai: GoogleGenAI;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private session: any = null;
  private recoveryAttempts = 0;
  private disposed = false;

  constructor(
    private config: VoiceProviderConfig,
    private callbacks: VoiceProviderCallbacks,
  ) {
    this.ai = new GoogleGenAI({ apiKey: config.apiKey });
  }

  async connect(): Promise<void> {
    this.session = await this.ai.live.connect({
      model: this.config.model,
      config: {
        responseModalities: [Modality.AUDIO],
        systemInstruction: {
          parts: [{ text: this.config.systemInstruction }],
        },
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: { voiceName: this.config.voiceName },
          },
        },
        tools: [{ functionDeclarations: this.config.tools }],
      },
      callbacks: {
        onopen: () => {
          const recovered = this.recoveryAttempts > 0;
          this.recoveryAttempts = 0;
          console.log(`[gemini] session open${recovered ? ' (recovered)' : ''}`);
          if (recovered) this.callbacks.onRecovered();
          else this.callbacks.onReady();
        },

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        onmessage: (message: any) => {
          const parts = message.serverContent?.modelTurn?.parts ?? [];
          for (const part of parts) {
            if (part.inlineData?.mimeType?.startsWith('audio/')) {
              this.callbacks.onAudio(part.inlineData.data, part.inlineData.mimeType);
            }
          }
          if (message.serverContent?.turnComplete) this.callbacks.onTurnComplete();
          if (message.serverContent?.interrupted) this.callbacks.onInterrupted();

          const functionCalls = message.toolCall?.functionCalls ?? [];
          if (functionCalls.length > 0) this.callbacks.onToolCalls(functionCalls);
        },

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        onerror: (e: any) => console.error('[gemini] error:', e),

        onclose: () => {
          console.log('[gemini] session closed');
          if (this.disposed) return;
          if (this.recoveryAttempts >= 3) {
            console.log('[gemini] recovery exhausted');
            this.callbacks.onClosed();
            return;
          }
          this.recoveryAttempts += 1;
          const delay = Math.min(1500 * 2 ** (this.recoveryAttempts - 1), 8000);
          console.log(`[gemini] recovering in ${delay}ms (attempt ${this.recoveryAttempts}/3)`);
          setTimeout(() => {
            if (this.disposed) return;
            this.connect().catch((err) => {
              console.error('[gemini] recovery connect failed:', err);
              this.callbacks.onClosed();
            });
          }, delay);
        },
      },
    });
  }

  sendAudio(data: string, mimeType: string): void {
    this.session?.sendRealtimeInput({
      audio: { data, mimeType: mimeType ?? 'audio/pcm;rate=16000' },
    });
  }

  sendText(text: string): void {
    this.session?.sendRealtimeInput({ text });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sendToolResponse(responses: any[]): void {
    Promise.resolve(this.session?.sendToolResponse({ functionResponses: responses })).catch(
      (e: unknown) => console.error('[gemini] sendToolResponse error:', e),
    );
  }

  close(): void {
    this.disposed = true;
    try { this.session?.close?.(); } catch { /* ignore */ }
  }
}

// ---------------------------------------------------------------------------
// Factory — the single switch for provider selection.
// ---------------------------------------------------------------------------

export function createProvider(
  config: VoiceProviderConfig,
  callbacks: VoiceProviderCallbacks,
): VoiceProvider {
  switch (config.provider) {
    case 'gemini':
    default:
      return new GeminiLiveProvider(config, callbacks);
  }
}
