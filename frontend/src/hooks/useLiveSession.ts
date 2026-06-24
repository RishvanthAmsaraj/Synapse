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
export function useLiveSession({ onAudioChunk, onInterrupted, onToolCall, onTurnComplete }: UseLiveSessionOptions) {
  const wsRef = useRef<WebSocket | null>(null);
  const [status, setStatus] = useState<SessionStatus>('disconnected');

  // Refs so ws.onmessage always calls the latest version of each callback
  // regardless of when connect() was called.
  const onAudioChunkRef = useRef(onAudioChunk);
  const onInterruptedRef = useRef(onInterrupted);
  const onToolCallRef = useRef(onToolCall);
  const onTurnCompleteRef = useRef(onTurnComplete);

  useEffect(() => { onAudioChunkRef.current = onAudioChunk; }, [onAudioChunk]);
  useEffect(() => { onInterruptedRef.current = onInterrupted; }, [onInterrupted]);
  useEffect(() => { onToolCallRef.current = onToolCall; }, [onToolCall]);
  useEffect(() => { onTurnCompleteRef.current = onTurnComplete; }, [onTurnComplete]);

  function connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      setStatus('connecting');

      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const ws = new WebSocket(`${protocol}//${window.location.host}/api/live`);
      wsRef.current = ws;

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data as string);

          switch (msg.type) {
            case 'ready':
              setStatus('connected');
              resolve();
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
            case 'turn_complete':
              onTurnCompleteRef.current?.();
              break;
          }
        } catch (err) {
          console.error('[session] Failed to parse message:', err);
        }
      };

      ws.onerror = (e) => {
        console.error('[session] WebSocket error:', e);
        setStatus('disconnected');
        reject(new Error('WebSocket error'));
      };

      ws.onclose = () => {
        setStatus('disconnected');
        wsRef.current = null;
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

  /** Minimum ms between context updates after turn_complete */
  const HOLD_MS = 300;

  /** Inject canvas state into the model's context. Debounces rapid cycles. */
  function sendContext(text: string) {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      const now = Date.now();
      if (now - lastSendRef.current < HOLD_MS) return; // debounce
      lastSendRef.current = now;
      wsRef.current.send(JSON.stringify({ type: 'context', text }));
    }
  }

  function disconnect() {
    wsRef.current?.close();
    wsRef.current = null;
    setStatus('disconnected');
  }

  return { connect, disconnect, sendAudio, sendContext, status };
}
