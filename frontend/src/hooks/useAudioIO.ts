import { useRef, useState } from 'react';

// Gemini Live expects 16kHz mono PCM
const INPUT_SAMPLE_RATE = 16000;

/**
 * Captures microphone input as 16-bit PCM chunks and calls onChunk
 * with each base64-encoded chunk.
 * 
 * Uses AudioWorklet for efficient audio processing without blocking
 * the main thread.
 */
export function useAudioIO(onChunk: (base64: string) => void) {
  const ctxRef = useRef<AudioContext | null>(null);
  const workletRef = useRef<AudioWorkletNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [isRecording, setIsRecording] = useState(false);

  async function start() {
    if (isRecording) return;

    const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    streamRef.current = stream;

    const ctx = new AudioContext({ sampleRate: INPUT_SAMPLE_RATE });
    ctxRef.current = ctx;

    await ctx.audioWorklet.addModule('/worklets/pcm-processor.js');

    const source = ctx.createMediaStreamSource(stream);
    const worklet = new AudioWorkletNode(ctx, 'pcm-processor');
    workletRef.current = worklet;

    worklet.port.onmessage = (e: MessageEvent<{ type: string; buffer: ArrayBuffer }>) => {
      if (e.data.type !== 'pcm') return;
      // Convert ArrayBuffer to base64
      const bytes = new Uint8Array(e.data.buffer);
      let binary = '';
      // Process in chunks to avoid call stack overflow on large buffers
      const chunkSize = 0x8000;
      for (let i = 0; i < bytes.length; i += chunkSize) {
        binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
      }
      onChunk(btoa(binary));
    };

    // source → worklet (do NOT connect worklet to destination — avoid feedback)
    source.connect(worklet);
    setIsRecording(true);
  }

  function stop() {
    workletRef.current?.disconnect();
    workletRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    ctxRef.current?.close();
    ctxRef.current = null;
    setIsRecording(false);
  }

  return { start, stop, isRecording };
}
