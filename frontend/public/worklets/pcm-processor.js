// AudioWorklet processor — captures mic input as 16-bit PCM chunks and
// posts a per-block RMS level so the UI orb reacts to the speaker's voice.
// Runs in the audio rendering thread; communicates via MessagePort.
class PCMProcessor extends AudioWorkletProcessor {
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
      const rms = Math.sqrt(sumSq / channelData.length);
      // Speech sits low on the meter; scale so the orb visibly responds.
      const level = Math.min(1, rms * 4.5);
      this.port.postMessage({ type: 'level', level });
      // Transfer the buffer (zero-copy) to the main thread
      this.port.postMessage({ type: 'pcm', buffer: pcm16.buffer }, [pcm16.buffer]);
    }
    return true; // keep processor alive
  }
}

registerProcessor('pcm-processor', PCMProcessor);
