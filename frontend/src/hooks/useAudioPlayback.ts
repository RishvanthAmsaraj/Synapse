import { useRef } from 'react';

// Gemini Live outputs 24kHz PCM audio
const OUTPUT_SAMPLE_RATE = 24000;

/**
 * Queues and plays PCM audio chunks from Gemini.
 * Uses a scheduled playback cursor so chunks play back-to-back without gaps.
 */
export function useAudioPlayback() {
  const ctxRef = useRef<AudioContext | null>(null);
  const nextPlayAtRef = useRef<number>(0);
  // Track all scheduled sources so flush() can stop them individually
  const sourcesRef = useRef<AudioBufferSourceNode[]>([]);

  function getCtx(): AudioContext {
    if (!ctxRef.current || ctxRef.current.state === 'closed') {
      ctxRef.current = new AudioContext({ sampleRate: OUTPUT_SAMPLE_RATE });
      nextPlayAtRef.current = 0;
    }
    return ctxRef.current;
  }

  function playChunk(base64: string) {
    const ctx = getCtx();

    // Resume context if suspended (browser autoplay policy)
    if (ctx.state === 'suspended') ctx.resume();

    // base64 → Uint8Array → Int16Array → Float32Array
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

    const pcm16 = new Int16Array(bytes.buffer);
    const float32 = new Float32Array(pcm16.length);
    for (let i = 0; i < pcm16.length; i++) {
      float32[i] = pcm16[i] / (pcm16[i] < 0 ? 0x8000 : 0x7fff);
    }

    const audioBuffer = ctx.createBuffer(1, float32.length, OUTPUT_SAMPLE_RATE);
    audioBuffer.getChannelData(0).set(float32);

    const source = ctx.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(ctx.destination);

    // Track the source; remove it from the list once it finishes naturally
    sourcesRef.current.push(source);
    source.onended = () => {
      sourcesRef.current = sourcesRef.current.filter((s) => s !== source);
    };

    const now = ctx.currentTime;
    const startAt = Math.max(now, nextPlayAtRef.current);
    source.start(startAt);
    nextPlayAtRef.current = startAt + audioBuffer.duration;
  }

  /**
   * Stop all queued audio immediately on barge-in / interruption.
   * Keeps the AudioContext alive so playback resumes cleanly without
   * any suspended-state or recreation race conditions.
   */
  function flush() {
    for (const source of sourcesRef.current) {
      try { source.stop(); } catch (_) { /* already ended */ }
    }
    sourcesRef.current = [];
    nextPlayAtRef.current = ctxRef.current ? ctxRef.current.currentTime : 0;
  }

  /** Full teardown on session end — closes the AudioContext entirely. */
  function stop() {
    flush();
    if (ctxRef.current && ctxRef.current.state !== 'closed') {
      ctxRef.current.close();
      ctxRef.current = null;
    }
  }

  return { playChunk, flush, stop };
}
