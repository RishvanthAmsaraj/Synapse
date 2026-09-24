import { useRef, useEffect, useState } from 'react';

export type SessionStatus = 'disconnected' | 'connecting' | 'connected';

export interface ToolCall {
  name: string;
  args: Record<string, unknown>;
}

interface UseLiveSessionOptions {
  onAudioChunk: (base64: string, mimeType: string) => void;
  onInterrupted: () => void;
  onToolCall: (call: ToolCall) => void;
  onTurnComplete?: () => void;
  /** Rolling text of what the agent is currently saying. */
  onTranscript?: (text: string) => void;
}

/**
 * Manages the WebSocket connection to the backend proxy.
 * Routes incoming audio chunks, tool calls, and session signals.
 * 
 * Message types:
 * - ready: Session established
 * - audio: Base64-encoded PCM audio chunk
 * - interrupted: User barge-in detected
 * - tool_call: Agent requested a widget action
 * - turn_complete: Agent finished speaking turn
 */
export function useLiveSession({ onAudioChunk, onInterrupted, onToolCall, onTurnComplete, onTranscript }: UseLiveSessionOptions) {
  const wsRef = useRef<WebSocket | null>(null);
  const [status, setStatus] = useState<SessionStatus>('disconnected');
  // Set when the user presses Stop — suppresses auto-reconnect.
  const manualCloseRef = useRef(false);
  const reconnectAttemptsRef = useRef(0);

  // Refs so ws.onmessage always calls the latest version of each callback
  // regardless of when connect() was called.
  const onAudioChunkRef = useRef(onAudioChunk);
  const onInterruptedRef = useRef(onInterrupted);
  const onToolCallRef = useRef(onToolCall);
  const onTurnCompleteRef = useRef(onTurnComplete);
  const onTranscriptRef = useRef(onTranscript);

  useEffect(() => { onAudioChunkRef.current = onAudioChunk; }, [onAudioChunk]);
  useEffect(() => { onInterruptedRef.current = onInterrupted; }, [onInterrupted]);
  useEffect(() => { onToolCallRef.current = onToolCall; }, [onToolCall]);
  useEffect(() => { onTurnCompleteRef.current = onTurnComplete; }, [onTurnComplete]);
  useEffect(() => { onTranscriptRef.current = onTranscript; }, [onTranscript]);

  /** Shared message handler for initial connect + reconnects. */
  const handleMessage = (raw: unknown, onReady?: () => void) => {
    try {
      const msg = JSON.parse(raw as string);

      switch (msg.type) {
        case 'ready':
          reconnectAttemptsRef.current = 0;
          setStatus('connected');
          onReady?.();
          break;
        case 'audio':
          onAudioChunkRef.current(msg.data as string, msg.mimeType as string);
          break;
        case 'interrupted':
          onInterruptedRef.current();
          break;
        case 'tool_call':
          onToolCallRef.current({ name: msg.name as string, args: msg.args as Record<string, unknown> });
          break;
        case 'transcript':
          onTranscriptRef.current?.(msg.text as string);
          break;
        case 'turn_complete':
          onTurnCompleteRef.current?.();
          break;
        case 'session_closed':
          // Gemini closed the session server-side (rate limit / timeout).
          // The onclose handler below reconnects automatically.
          break;
      }
    } catch (err) {
      console.error('[session] Failed to parse message:', err);
    }
  };

  /** Open a socket. Auto-reconnects with backoff unless the user stopped. */
  const openSocket = (onReady?: () => void) => {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    // Persona rides on the connect URL: identity, voice and teaching style are
    // fixed for the life of a Live session, so switching means reconnecting.
    // It lives in a ref because openSocket is also the auto-reconnect path —
    // dropping the connection must not silently change who is talking.
    const q = personaRef.current ? `?persona=${encodeURIComponent(personaRef.current)}` : '';
    const ws = new WebSocket(`${protocol}//${window.location.host}/api/live${q}`);
    wsRef.current = ws;

    ws.onmessage = (event) => handleMessage(event.data, onReady);

    ws.onerror = (e) => {
      console.error('[session] WebSocket error:', e);
    };

    ws.onclose = () => {
      wsRef.current = null;
      if (manualCloseRef.current) {
        setStatus('disconnected');
        reconnectAttemptsRef.current = 0;
        return;
      }
      // Unexpected close (Gemini rate limit, session timeout, network):
      // reconnect with exponential backoff, up to 5 attempts.
      const attempt = reconnectAttemptsRef.current + 1;
      reconnectAttemptsRef.current = attempt;
      if (attempt > 5) {
        setStatus('disconnected');
        reconnectAttemptsRef.current = 0;
        return;
      }
      const delay = Math.min(1500 * 2 ** (attempt - 1), 12000);
      console.log(`[session] Reconnecting in ${delay}ms (attempt ${attempt})`);
      setStatus('connecting');
      setTimeout(() => {
        if (manualCloseRef.current) return;
        openSocket();
      }, delay);
    };
  };

  function connect(persona?: string): Promise<void> {
    personaRef.current = persona;
    return new Promise((resolve, reject) => {
      setStatus('connecting');
      manualCloseRef.current = false;
      reconnectAttemptsRef.current = 0;
      openSocket(() => resolve());
      // If the first handshake fails outright, surface it via the promise.
      const ws = wsRef.current;
      if (!ws) {
        reject(new Error('WebSocket construction failed'));
        return;
      }
      const originalError = ws.onerror;
      ws.onerror = (e) => {
        originalError?.call(ws, e);
        setStatus('disconnected');
        reject(new Error('WebSocket error'));
      };
    });
  }

  function sendAudio(base64: string) {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(
        JSON.stringify({ type: 'audio', data: base64, mimeType: 'audio/pcm;rate=16000' })
      );
    }
  }

  /** Last context send timestamp — used to debounce rapid cycles */
  const lastSendRef = useRef(0);
  /** Last context payload — identical state is not worth re-sending */
  const lastTextRef = useRef<string>('');
  /** Persona for this session, preserved across reconnects. */
  const personaRef = useRef<string | undefined>(undefined);

  /** Minimum ms between context updates after turn_complete */
  const HOLD_MS = 300;

  /**
   * Inject canvas state into the model's context.
   *
   * Deduplicated as well as debounced: this fires on every turn_complete, and
   * the canvas usually has not changed between turns. Re-sending an identical
   * status line just grows the context window for no benefit.
   */
  function sendContext(text: string) {
    if (wsRef.current?.readyState !== WebSocket.OPEN) return;
    if (text === lastTextRef.current) return;
    const now = Date.now();
    if (now - lastSendRef.current < HOLD_MS) return;
    lastSendRef.current = now;
    lastTextRef.current = text;
    wsRef.current.send(JSON.stringify({ type: 'context', text }));
  }

  function disconnect() {
    manualCloseRef.current = true;
    wsRef.current?.close();
    wsRef.current = null;
    setStatus('disconnected');
  }

  return { connect, disconnect, sendAudio, sendContext, status };
}
