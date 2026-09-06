import { useEffect, useRef } from 'react';

// Gemini Live outputs 24kHz PCM audio
const OUTPUT_SAMPLE_RATE = 24000;

/**
 * Queues and plays PCM audio chunks from Gemini.
 * Uses a scheduled playback cursor so chunks play back-to-back without gaps.
 *
 * Also reports a live output level (0-1) through onLevel, computed from an
 * AnalyserNode on the output chain — this drives the orb's audio reactivity
 * while the agent speaks.
 */
export function useAudioPlayback(onLevel?: (level: number) => void) {
  const ctxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const nextPlayAtRef = useRef<number>(0);
  // Track all scheduled sources so flush() can stop them individually
  const sourcesRef = useRef<AudioBufferSourceNode[]>([]);
  const pumpRef = useRef<number | null>(null);

  // Keep the latest onLevel without recreating the pump
  const onLevelRef = useRef(onLevel);
  useEffect(() => { onLevelRef.current = onLevel; }, [onLevel]);

  function getCtx(): AudioContext {
    if (!ctxRef.current || ctxRef.current.state === 'closed') {
      ctxRef.current = new AudioContext({ sampleRate: OUTPUT_SAMPLE_RATE });
      nextPlayAtRef.current = 0;

      // Level metering: all playback routes through this analyser on its
      // way to the speakers, so the orb reacts to the agent's voice.
      const analyser = ctxRef.current.createAnalyser();
      analyser.fftSize = 1024;
      analyser.smoothingTimeConstant = 0.4;
      analyser.connect(ctxRef.current.destination);
      analyserRef.current = analyser;
    }
    return ctxRef.current;
  }

  /** rAF pump: reads the analyser and reports the current RMS level. */
  function startPump() {
    if (pumpRef.current != null) return;
    const tick = () => {
      const analyser = analyserRef.current;
      const ctx = ctxRef.current;
      if (analyser && ctx && ctx.state !== 'closed') {
        const buf = new Uint8Array(analyser.fftSize);
        analyser.getByteTimeDomainData(buf);
        let sumSq = 0;
        for (let i = 0; i < buf.length; i++) {
          const v = (buf[i] - 128) / 128;
          sumSq += v * v;
        }
        const rms = Math.sqrt(sumSq / buf.length);
        onLevelRef.current?.(Math.min(1, rms * 3.5));
        pumpRef.current = requestAnimationFrame(tick);
      } else {
        pumpRef.current = null;
      }
    };
    pumpRef.current = requestAnimationFrame(tick);
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
    // Route through the analyser so the orb can meter agent speech
    source.connect(analyserRef.current ?? ctx.destination);

    // Track the source; remove it from the list once it finishes naturally
    sourcesRef.current.push(source);
    source.onended = () => {
      sourcesRef.current = sourcesRef.current.filter((s) => s !== source);
    };

    const now = ctx.currentTime;
    const startAt = Math.max(now, nextPlayAtRef.current);
    source.start(startAt);
    nextPlayAtRef.current = startAt + audioBuffer.duration;

    startPump();
  }

  /**
   * Stop all queued audio immediately on barge-in / interruption.
   * Keeps the AudioContext alive so playback resumes cleanly without
   * any suspended-state or recreation race conditions.
   * Uses a 30ms exponential fade-out to avoid the audible pop/clip
   * that abrupt `.stop()` can produce.
   */
  function flush() {
    for (const source of sourcesRef.current) {
      try {
        // Quick fade-out to avoid audible pop
        const now = source.context.currentTime;
        const gain = source.context.createGain();
        source.disconnect();
        source.connect(gain);
        gain.connect(source.context.destination);
        gain.gain.setValueAtTime(1, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.03);
        source.stop(now + 0.03);
      } catch (_) { /* already ended or disposed */ }
    }
    sourcesRef.current = [];
    nextPlayAtRef.current = ctxRef.current ? ctxRef.current.currentTime : 0;
  }

  /** Full teardown on session end — closes the AudioContext entirely. */
  function stop() {
    flush();
    if (pumpRef.current != null) {
      cancelAnimationFrame(pumpRef.current);
      pumpRef.current = null;
    }
    if (ctxRef.current && ctxRef.current.state !== 'closed') {
      ctxRef.current.close();
      ctxRef.current = null;
    }
    analyserRef.current = null;
  }

  return { playChunk, flush, stop };
}
