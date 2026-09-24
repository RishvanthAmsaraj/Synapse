import { VISEMES, type Viseme, type VisemeFrame, classifySpectrum } from './lipsync';

/**
 * visemeTrack.ts — lip sync that is actually in sync.
 *
 * The previous approach hung an AnalyserNode off the output and read it once
 * per animation frame. That works, but everything it touches adds latency:
 * the node's own smoothing, the envelope follower, coarticulation easing and
 * the AU animator each contribute, and by the time the jaw moved it was
 * 150–250 ms behind the voice. At that offset a viewer does not read "slightly
 * late", they read "not synced".
 *
 * The fix is to stop reacting and start reading ahead. Playback already
 * schedules every PCM chunk at a known point on the AudioContext clock
 * (see useAudioPlayback), so at the moment a chunk is queued we possess the
 * entire waveform of speech that has not been heard yet. Analysing it there
 * gives a timestamped track of viseme frames that the renderer samples by
 * clock position instead of by reaction.
 *
 * Two things fall out of that. Smoothing becomes free — it runs over the
 * frame array offline, so coarticulation costs no latency at all. And the
 * mouth can be given a small deliberate LEAD, because human perception treats
 * visible articulation slightly ahead of sound as simultaneous, while the
 * reverse reads as dubbing.
 */

const FFT_SIZE = 512;
const HOP = 256;
/** ~5 minutes of speech. Only reached if the track is never sampled. */
const MAX_FRAMES = 28000;

// ── Radix-2 FFT ────────────────────────────────────────────────────────

const REV = new Uint16Array(FFT_SIZE);
(() => {
  const bits = Math.log2(FFT_SIZE);
  for (let i = 0; i < FFT_SIZE; i++) {
    let r = 0;
    for (let b = 0; b < bits; b++) if (i & (1 << b)) r |= 1 << (bits - 1 - b);
    REV[i] = r;
  }
})();

const COS = new Float32Array(FFT_SIZE / 2);
const SIN = new Float32Array(FFT_SIZE / 2);
for (let i = 0; i < FFT_SIZE / 2; i++) {
  COS[i] = Math.cos((-2 * Math.PI * i) / FFT_SIZE);
  SIN[i] = Math.sin((-2 * Math.PI * i) / FFT_SIZE);
}

const HANN = new Float32Array(FFT_SIZE);
for (let i = 0; i < FFT_SIZE; i++) {
  HANN[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (FFT_SIZE - 1)));
}

const re = new Float32Array(FFT_SIZE);
const im = new Float32Array(FFT_SIZE);

/** In-place iterative Cooley–Tukey. Operates on the module-level scratch. */
function fft() {
  for (let i = 0; i < FFT_SIZE; i++) {
    const j = REV[i];
    if (j > i) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  for (let size = 2; size <= FFT_SIZE; size <<= 1) {
    const half = size >> 1;
    const step = FFT_SIZE / size;
    for (let i = 0; i < FFT_SIZE; i += size) {
      for (let j = 0; j < half; j++) {
        const k = j * step;
        const tr = re[i + j + half] * COS[k] - im[i + j + half] * SIN[k];
        const ti = re[i + j + half] * SIN[k] + im[i + j + half] * COS[k];
        re[i + j + half] = re[i + j] - tr;
        im[i + j + half] = im[i + j] - ti;
        re[i + j] += tr;
        im[i + j] += ti;
      }
    }
  }
}

// ── Track ──────────────────────────────────────────────────────────────

interface Frame {
  t: number; // AudioContext time this frame is heard at
  v: Float32Array; // one weight per viseme, ordered as VISEMES
  energy: number;
}

export class VisemeTrack {
  private frames: Frame[] = [];
  /** Samples carried over so analysis windows span chunk boundaries. */
  private residual: Float32Array = new Float32Array(0);
  private residualTime = 0;
  private sampleRate = 0;
  private mag = new Float32Array(FFT_SIZE / 2);
  /** Carried across chunks so closure detection sees continuous speech. */
  private prevEnergy = 0;
  private voicedRun = 0;

  /**
   * Analyse one decoded PCM chunk that will begin playing at `startTime` on
   * the AudioContext clock.
   */
  push(pcm: Float32Array, sampleRate: number, startTime: number) {
    if (sampleRate !== this.sampleRate) this.sampleRate = sampleRate;
    const binHz = sampleRate / FFT_SIZE;

    // Glue the tail of the previous chunk on so windows stay continuous.
    let buf: Float32Array;
    let bufTime: number;
    if (this.residual.length > 0 && Math.abs(this.residualTime - startTime) < 0.25) {
      buf = new Float32Array(this.residual.length + pcm.length);
      buf.set(this.residual, 0);
      buf.set(pcm, this.residual.length);
      bufTime = startTime - this.residual.length / sampleRate;
    } else {
      buf = pcm;
      bufTime = startTime;
    }

    const produced: Frame[] = [];
    let off = 0;
    for (; off + FFT_SIZE <= buf.length; off += HOP) {
      let sumSq = 0;
      for (let i = 0; i < FFT_SIZE; i++) {
        const x = buf[off + i];
        sumSq += x * x;
        re[i] = x * HANN[i];
        im[i] = 0;
      }
      // Level is measured on the raw window, not the transform: the FFT's
      // magnitude scale depends on window and size, RMS does not.
      const rms = Math.sqrt(sumSq / FFT_SIZE);
      fft();

      for (let i = 0; i < FFT_SIZE / 2; i++) {
        this.mag[i] = Math.sqrt(re[i] * re[i] + im[i] * im[i]);
      }

      const { weights, energy } = classifySpectrum(this.mag, binHz, rms);
      const v = new Float32Array(VISEMES.length);
      for (let i = 0; i < VISEMES.length; i++) v[i] = weights[VISEMES[i]];
      // The window is centred, so the frame is heard half a window in.
      produced.push({ t: bufTime + (off + FFT_SIZE / 2) / sampleRate, v, energy });
    }

    this.residual = buf.slice(off);
    this.residualTime = startTime + pcm.length / sampleRate;

    this.detectClosures(produced);
    this.smooth(produced);
    this.frames.push(...produced);
    this.prune();
  }

  /**
   * Stop consonants — /p b m/ — are a moment of silence produced by the lips
   * actually meeting. Spectrally they are indistinguishable from a pause, so
   * they cannot be classified frame by frame; they have to be found by
   * looking at where voiced speech stops. A mouth that never fully closes
   * between words is the single most obvious tell of synthetic lip sync.
   */
  private detectClosures(list: Frame[]) {
    const dt = HOP / this.sampleRate;
    const mIdx = VISEMES.indexOf('M');
    let closure = 0;
    for (const f of list) {
      const speaking = f.energy > 0.045;
      if (speaking) {
        this.voicedRun += dt;
      } else {
        if (this.voicedRun > 0.07 && this.prevEnergy > 0.11) closure = 1;
        this.voicedRun = 0;
      }
      this.prevEnergy = f.energy;
      if (closure > 0.01) {
        f.v[mIdx] = Math.max(f.v[mIdx], closure * 0.85);
        closure = Math.max(0, closure - dt * 4.5);
      }
    }
  }

  /**
   * Coarticulation, applied across the frame array rather than over time.
   *
   * Because this runs ahead of playback it can look forwards as well as
   * backwards, so the mouth begins forming a sound slightly before it is
   * heard — which is what real articulators do, and is impossible to
   * reproduce with a reactive filter.
   */
  private smooth(list: Frame[]) {
    if (list.length < 2) return;
    const n = list.length;
    const dt = HOP / this.sampleRate;
    const kUp = 1 - Math.exp(-dt / 0.022);
    const kDn = 1 - Math.exp(-dt / 0.055);

    // Backward pass gives the anticipatory lead-in.
    for (let i = n - 2; i >= 0; i--) {
      for (let k = 0; k < VISEMES.length; k++) {
        const nxt = list[i + 1].v[k];
        if (nxt > list[i].v[k]) list[i].v[k] += (nxt - list[i].v[k]) * 0.34;
      }
    }
    // Forward pass is the physical settle.
    for (let i = 1; i < n; i++) {
      for (let k = 0; k < VISEMES.length; k++) {
        const prev = list[i - 1].v[k];
        const cur = list[i].v[k];
        list[i].v[k] = prev + (cur - prev) * (cur > prev ? kUp : kDn);
      }
      list[i].energy = list[i - 1].energy + (list[i].energy - list[i - 1].energy) * 0.5;
    }
  }

  /**
   * Safety valve only. Real pruning happens in sample(), against the audio
   * clock — this just stops unbounded growth if nothing ever reads the track.
   */
  private prune() {
    if (this.frames.length <= MAX_FRAMES) return;
    this.frames.splice(0, this.frames.length - MAX_FRAMES);
  }

  /** Read the mouth pose for a given point on the audio clock. */
  sample(t: number): VisemeFrame {
    // Discard what has already been heard.
    //
    // This used to be a count-based prune in push(), keeping the newest ~384
    // frames — about four seconds. Gemini streams audio considerably faster
    // than realtime, so during a long explanation the queue runs further ahead
    // than that and the prune was deleting the OLDEST frames: precisely the
    // ones the mouth was about to need. Short replies stayed in sync and long
    // ones fell apart, which is exactly the reported symptom. Pruning against
    // the playback clock instead means only genuinely past frames are dropped,
    // however far ahead the buffer runs.
    if (this.frames.length > 64) {
      const cutoff = t - 1.0;
      let drop = 0;
      while (drop < this.frames.length - 32 && this.frames[drop].t < cutoff) drop++;
      if (drop > 0) this.frames.splice(0, drop);
    }

    const out = emptyVisemeFrame();
    const f = this.frames;
    if (f.length === 0) return out;
    if (t <= f[0].t || t >= f[f.length - 1].t + 0.2) return out;

    // Binary search for the bracketing pair.
    let lo = 0, hi = f.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (f[mid].t <= t) lo = mid; else hi = mid;
    }
    const a = f[lo], b = f[hi];
    const span = b.t - a.t || 1e-6;
    const u = Math.max(0, Math.min(1, (t - a.t) / span));

    for (let i = 0; i < VISEMES.length; i++) {
      out[VISEMES[i]] = a.v[i] + (b.v[i] - a.v[i]) * u;
    }
    out.energy = a.energy + (b.energy - a.energy) * u;
    out.silent = out.energy <= 0.045;
    return out;
  }

  /** Barge-in: the queued audio is gone, so the mouth pose must go with it. */
  clear() {
    this.frames.length = 0;
    this.residual = new Float32Array(0);
    this.residualTime = 0;
    this.prevEnergy = 0;
    this.voicedRun = 0;
  }

  get length() {
    return this.frames.length;
  }
}

export function emptyVisemeFrame(): VisemeFrame {
  const o = { energy: 0, silent: true } as VisemeFrame;
  for (const v of VISEMES) o[v as Viseme] = 0;
  return o;
}
