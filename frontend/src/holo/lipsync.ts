/**
 * lipsync.ts — turns the TTS output spectrum into viseme weights.
 *
 * Gemini Live gives us raw audio and no phoneme timing, so the previous build
 * mapped loudness straight onto jaw angle. That produces the classic puppet
 * flap: the mouth opens the same way for "sss" as for "ahh", and it never
 * closes between words.
 *
 * Instead we read the FFT we were already computing and classify each frame
 * by where its energy sits. Vowel identity is carried almost entirely by the
 * first two formants, and the broad bands below are enough to separate them:
 *
 *   F1 high + F2 low   → open back vowel   /ɑ/   jaw wide
 *   F1 low  + F2 high  → close front vowel /i/   lips wide, jaw nearly shut
 *   F1 low  + F2 low   → close back vowel  /u/   lips rounded
 *   broadband HF, no voicing → sibilant    /s/   teeth close, lips tense
 *   energy collapse after voicing → bilabial closure /m,b,p/
 *
 * The output is a set of continuous, overlapping viseme weights rather than a
 * hard classification — real articulation is a blend, and coarticulation is
 * what stops the mouth looking quantised.
 */

export const VISEMES = ['aa', 'E', 'I', 'O', 'U', 'M', 'F', 'S', 'L'] as const;
export type Viseme = (typeof VISEMES)[number];

export type VisemeFrame = Record<Viseme, number> & {
  /** Overall speech energy, 0–1. */
  energy: number;
  /** True while the analyser sees no voice at all. */
  silent: boolean;
};

const EMPTY: VisemeFrame = {
  aa: 0, E: 0, I: 0, O: 0, U: 0, M: 0, F: 0, S: 0, L: 0,
  energy: 0, silent: true,
};

/** Band edges in Hz, chosen around the formant regions described above. */
const BANDS: Array<[number, number]> = [
  [70, 320],     // 0 voicing / F0
  [320, 780],    // 1 F1 low   — close vowels
  [780, 1350],   // 2 F1 high  — open vowels
  [1350, 2150],  // 3 F2 low   — back vowels
  [2150, 3400],  // 4 F2 high  — front vowels
  [3400, 6200],  // 5 fricative
  [6200, 11000], // 6 sibilant
];

export class LipsyncAnalyser {
  // Explicitly backed by ArrayBuffer: getByteFrequencyData rejects a
  // possibly-shared buffer under TS 5.7+ typed-array generics.
  private bins: Uint8Array<ArrayBuffer>;
  private sampleRate: number;
  private fftSize: number;
  private ranges: Array<[number, number]> = [];

  /** Smoothed viseme state, so output is continuous across frames. */
  private smooth: Record<Viseme, number> = { aa: 0, E: 0, I: 0, O: 0, U: 0, M: 0, F: 0, S: 0, L: 0 };
  private energy = 0;
  private prevEnergy = 0;
  private silenceFor = 0;
  private voicedFor = 0;
  /** Fires briefly after voicing stops — drives the closure at word ends. */
  private closure = 0;

  constructor(fftSize: number, sampleRate: number) {
    this.fftSize = fftSize;
    this.sampleRate = sampleRate;
    this.bins = new Uint8Array(new ArrayBuffer(fftSize / 2));
    const nyquist = sampleRate / 2;
    const perBin = nyquist / this.bins.length;
    this.ranges = BANDS.map(([lo, hi]) => [
      Math.max(0, Math.floor(lo / perBin)),
      Math.min(this.bins.length - 1, Math.ceil(hi / perBin)),
    ]);
  }

  /** Analyse one frame. `analyser` must be the live output AnalyserNode. */
  analyse(analyser: AnalyserNode | null, dt: number): VisemeFrame {
    if (!analyser) {
      this.decayAll(dt);
      return this.emit();
    }
    if (analyser.frequencyBinCount !== this.bins.length) {
      this.bins = new Uint8Array(new ArrayBuffer(analyser.frequencyBinCount));
    }
    analyser.getByteFrequencyData(this.bins);

    // ── Band energies, loudness-compensated ───────────────────────────
    const band: number[] = [];
    for (const [lo, hi] of this.ranges) {
      let s = 0;
      for (let i = lo; i <= hi; i++) s += this.bins[i];
      band.push(s / Math.max(1, hi - lo + 1) / 255);
    }

    const voiced = band[0] + band[1] + band[2];
    const high = band[5] + band[6];
    const total = voiced + band[3] + band[4] + high;

    const raw = Math.min(1, total * 0.62);
    // Asymmetric envelope: articulators accelerate fast and relax slowly.
    // Symmetric smoothing is what makes machine lipsync look rubbery.
    const k = raw > this.energy ? 1 - Math.exp(-dt / 0.028) : 1 - Math.exp(-dt / 0.085);
    this.energy += (raw - this.energy) * k;

    const speaking = this.energy > 0.045;
    if (speaking) {
      this.voicedFor += dt;
      this.silenceFor = 0;
    } else {
      this.silenceFor += dt;
      // A short, sharp drop after sustained voicing is a stop consonant —
      // the lips actually meet. Without this the mouth never truly shuts.
      if (this.voicedFor > 0.08 && this.prevEnergy > 0.12) this.closure = 1;
      this.voicedFor = 0;
    }
    this.prevEnergy = this.energy;
    this.closure = Math.max(0, this.closure - dt * 4.5);

    if (!speaking) {
      this.decayAll(dt);
      this.smooth.M = Math.max(this.smooth.M, this.closure * 0.65);
      return this.emit();
    }

    // ── Formant-shape descriptors ─────────────────────────────────────
    const eps = 1e-4;
    // Openness: how much of the low-frequency energy sits in the F1-high
    // band. Open vowels push F1 up; close vowels keep it down.
    const openness = band[2] / (band[1] + band[2] + eps);
    // Frontness: F2 balance. Front vowels (/i/, /e/) put energy high.
    const frontness = band[4] / (band[3] + band[4] + eps);
    // Sibilance: HF energy relative to everything, with voicing discounted.
    const sibilance = high / (total + eps);
    // Rounding suppresses F2 outright — dark spectrum with real voicing.
    const rounding = 1 - Math.min(1, (band[3] + band[4]) / (voiced + eps) * 1.35);

    const t: Record<Viseme, number> = { aa: 0, E: 0, I: 0, O: 0, U: 0, M: 0, F: 0, S: 0, L: 0 };

    if (sibilance > 0.34) {
      // Fricative family. /s ʃ/ sit higher than /f v/, so band 6 vs 5 splits
      // them: sibilants keep the teeth close, labiodentals tuck the lip.
      const sharp = band[6] / (band[5] + band[6] + eps);
      t.S = Math.min(1, (sibilance - 0.28) * 2.6) * sharp;
      t.F = Math.min(1, (sibilance - 0.28) * 2.6) * (1 - sharp);
      t.E = 0.16;
    } else {
      const vowel = 1 - Math.min(1, sibilance * 1.8);
      const open = Math.min(1, openness * 1.55);
      const front = Math.min(1, frontness * 1.35);
      const round = Math.max(0, Math.min(1, rounding));

      t.aa = vowel * open * (1 - round) * (0.45 + 0.55 * (1 - front));
      t.E = vowel * (1 - Math.abs(open - 0.5) * 1.7) * front * (1 - round);
      t.I = vowel * (1 - open) * front * (1 - round);
      t.O = vowel * open * round;
      t.U = vowel * (1 - open) * round;
      // Alveolars ride under vowels; a touch keeps the mouth from freezing
      // on sustained tones.
      t.L = vowel * 0.14 * (1 - open);
    }

    t.M = this.closure * 0.8;

    // Normalise so the blend never over-drives the rig.
    let sum = 0;
    for (const v of VISEMES) sum += t[v];
    if (sum > 1) for (const v of VISEMES) t[v] /= sum;

    const gain = Math.min(1, this.energy * 1.5);
    for (const v of VISEMES) {
      const target = t[v] * gain;
      // Per-viseme coarticulation: transitions ease in over ~40 ms and out
      // over ~90 ms, which is roughly human articulator travel time.
      const rate = target > this.smooth[v] ? 0.040 : 0.090;
      this.smooth[v] += (target - this.smooth[v]) * (1 - Math.exp(-dt / rate));
    }

    return this.emit();
  }

  private decayAll(dt: number) {
    const f = 1 - Math.exp(-dt / 0.11);
    for (const v of VISEMES) this.smooth[v] -= this.smooth[v] * f;
    this.energy -= this.energy * (1 - Math.exp(-dt / 0.09));
  }

  private emit(): VisemeFrame {
    return {
      ...this.smooth,
      energy: this.energy,
      silent: this.energy <= 0.045,
    };
  }

  reset() {
    for (const v of VISEMES) this.smooth[v] = 0;
    this.energy = 0;
    this.prevEnergy = 0;
    this.closure = 0;
    this.silenceFor = 0;
    this.voicedFor = 0;
    void this.fftSize;
    void this.sampleRate;
  }
}

export function emptyFrame(): VisemeFrame {
  return { ...EMPTY };
}

/**
 * Viseme → Action Unit mapping.
 *
 * Each viseme names the mouth posture it produces. Weights are additive and
 * get clamped downstream, so overlapping visemes blend the way real
 * coarticulated speech does.
 */
export const VISEME_TO_AU: Record<Viseme, Partial<Record<string, number>>> = {
  // /ɑ/ — jaw drops, lips relaxed and slightly wide
  aa: { jawOpen: 0.88, lipsPart: 0.55, lipStretch: 0.12, mtMouthOpen: 0.35 },
  // /ɛ/ — mid-open, corners drawn out
  E: { jawOpen: 0.44, lipsPart: 0.52, lipStretch: 0.36, mtMouthOpen: 0.18 },
  // /i/ — barely open, lips spread hard
  I: { jawOpen: 0.15, lipsPart: 0.44, lipStretch: 0.66, mtMouthSmile: 0.18 },
  // /o/ — rounded and open
  O: { jawOpen: 0.46, lipPucker: 0.58, jawThrust: 0.22, lipsPart: 0.30 },
  // /u/ — tight round purse
  U: { jawOpen: 0.14, lipPucker: 0.92, jawThrust: 0.32 },
  // /m b p/ — full bilabial closure
  M: { jawOpen: 0.0, lipsPress: 0.80, lipsPart: -0.25 },
  // /f v/ — lower lip to upper teeth
  F: { jawOpen: 0.11, lipsPress: 0.38, upperLipRaise: 0.24, lipStretch: 0.15 },
  // /s z ʃ/ — teeth nearly closed, lips tense and wide
  S: { jawOpen: 0.10, lipStretch: 0.46, lipsPart: 0.26 },
  // /l n d t/ — small neutral aperture
  L: { jawOpen: 0.30, lipsPart: 0.58 },
};
