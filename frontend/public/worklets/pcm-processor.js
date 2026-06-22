// AudioWorklet processor — captures mic input as 16-bit PCM chunks
// Runs in the audio rendering thread; communicates via MessagePort.
class PCMProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const channelData = inputs[0]?.[0];
    if (channelData && channelData.length > 0) {
      const pcm16 = new Int16Array(channelData.length);
      for (let i = 0; i < channelData.length; i++) {
        const s = Math.max(-1, Math.min(1, channelData[i]));
        pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
      }
      // Transfer the buffer (zero-copy) to the main thread
      this.port.postMessage({ type: 'pcm', buffer: pcm16.buffer }, [pcm16.buffer]);
    }
    return true; // keep processor alive
  }
}

registerProcessor('pcm-processor', PCMProcessor);
