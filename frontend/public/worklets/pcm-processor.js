// AudioWorklet processor — captures mic input as 16-bit PCM chunks and
// posts a per-block RMS level so the UI orb reacts to the speaker's voice.
// Runs in the audio rendering thread; communicates via MessagePort.
class PCMProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.tick = 0;
  }

  process(inputs) {
    const channelData = inputs[0]?.[0];
    if (channelData && channelData.length > 0) {
      const pcm16 = new Int16Array(channelData.length);
      let sumSq = 0;
      for (let i = 0; i < channelData.length; i++) {
        const s = Math.max(-1, Math.min(1, channelData[i]));
        sumSq += s * s;
        pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
      }
      // The meter drives a visual that updates at frame rate, so posting it
      // every 8ms render quantum was ~125 redundant messages a second
      // competing with the audio frames on the same port.
      this.tick++;
      if (this.tick % 5 === 0) {
        const rms = Math.sqrt(sumSq / channelData.length);
        const level = Math.min(1, rms * 4.5);
        this.port.postMessage({ type: 'level', level });
      }
      // Transfer the buffer (zero-copy) to the main thread
      this.port.postMessage({ type: 'pcm', buffer: pcm16.buffer }, [pcm16.buffer]);
    }
    return true; // keep processor alive
  }
}

registerProcessor('pcm-processor', PCMProcessor);
