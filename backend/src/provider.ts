// ---------------------------------------------------------------------------
// Voice provider abstraction — the backend speaks to a voice model through a
// single interface, so Gemini Live (default, free-tier) and OpenAI Realtime
// (premium smoothness) are swappable behind the same wall. server.ts only
// knows this interface; adding a provider means adding one class + a case in
// createProvider, nothing else.
// ---------------------------------------------------------------------------

import { GoogleGenAI, Modality, StartSensitivity, EndSensitivity } from '@google/genai';

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
  /** Rolling transcript of what the model is saying, for captions/debug. */
  onOutputTranscript?: (text: string) => void;
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

        // Voice activity detection.
        //
        // These two knobs pull in opposite directions and I previously set
        // both the wrong way round.
        //
        // startOfSpeechSensitivity governs how readily the model accepts that
        // YOU have started talking — which is exactly what barge-in is. LOW
        // made it hard to interrupt and made it drop short utterances
        // altogether. It is HIGH now; echo from the speakers is handled where
        // it should be, by echo cancellation on the microphone, not by making
        // the agent hard of hearing.
        //
        // endOfSpeechSensitivity governs how eagerly it decides you have
        // FINISHED. LOW is the patient setting, and it is what lets a long
        // multi-part question survive the pauses inside it — so the silence
        // window no longer has to be padded out to compensate, which is where
        // the response delay was coming from.
        realtimeInputConfig: {
          automaticActivityDetection: {
            startOfSpeechSensitivity: StartSensitivity.START_SENSITIVITY_HIGH,
            endOfSpeechSensitivity: EndSensitivity.END_SENSITIVITY_LOW,
            // Short enough that "wait—" registers as an interruption.
            prefixPaddingMs: 100,
            // This is the single largest fixed cost in a turn: the model waits
            // this long after you stop before it will even begin. Every ms
            // here is felt directly as "it takes a second to answer". It is
            // safe to keep it short because endOfSpeechSensitivity is LOW —
            // that is what protects the pauses inside a long question, so the
            // silence window does not have to do that job as well.
            // 450ms was too eager: a long multi-part request has pauses in
            // it, and ending the turn on one delivers half a sentence — the
            // model then has nothing coherent to answer, which reads as it
            // ignoring you. Start sensitivity stays HIGH so barge-in is
            // unaffected by this.
            silenceDurationMs: 620,
          },
        },

        // Gives us the text of what the model is currently saying.
        outputAudioTranscription: {},
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
          const outText = message.serverContent?.outputTranscription?.text;
          if (outText) this.callbacks.onOutputTranscript?.(outText);

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

  /**
   * Inject silent context (canvas state) WITHOUT provoking a reply.
   *
   * This used to call sendRealtimeInput({ text }). Per the Live API,
   * "detected voice and text input count as activity" — so realtime text ends
   * the user's turn and makes the model answer it. Since the client injects
   * canvas state on every turn_complete, that formed a loop: the model would
   * finish speaking, receive the status line as if the user had spoken, reply
   * to it, complete another turn, and go round again roughly once a second.
   * That is the "it keeps asking what can I help you with" behaviour.
   *
   * sendClientContent with turnComplete: false appends to the context in
   * order and generates nothing. The status line then rides along with the
   * user's next real utterance, which is what it was always meant to do.
   */
  sendText(text: string): void {
    this.session?.sendClientContent({
      turns: [{ role: 'user', parts: [{ text }] }],
      turnComplete: false,
    });
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
