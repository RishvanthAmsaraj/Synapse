/**
 * lipsync.ts — deciding which mouth shape a moment of audio calls for.
 *
 * Gemini Live returns audio and no phoneme timing, so the shape has to be
 * recovered from the signal. Vowel identity is carried almost entirely by the
 * first two formants, and broad energy bands are enough to separate them:
 *
 *   F1 high + F2 low   → open back vowel   /ɑ/   jaw wide
 *   F1 low  + F2 high  → close front vowel /i/   lips spread, jaw nearly shut
 *   F1 low  + F2 low   → close back vowel  /u/   lips rounded
 *   broadband HF       → sibilant          /s/   teeth close, lips tense
 *
 * Everything here is a pure function of one frame's band energies. State —
 * closures, coarticulation, envelopes — lives in visemeTrack, which sees the
 * whole utterance ahead of playback and can therefore do a better job of it
 * than any reactive filter could.
 */

export const VISEMES = ['aa', 'E', 'I', 'O', 'U', 'M', 'F', 'S', 'L'] as const;
export type Viseme = (typeof VISEMES)[number];

export type VisemeFrame = Record<Viseme, number> & {
  /** Overall speech energy, 0–1. */
  energy: number;
  /** True when the analyser sees no voice at all. */
  silent: boolean;
};

/**
 * Vowel prototypes in the F1/F2 plane, in Hz.
 *
 * This is the standard vowel space: F1 tracks how open the jaw is, F2 tracks
 * how far forward the tongue sits. Classifying against prototypes here is far
 * more robust than thresholding fixed frequency bands, because real formants
 * move across band edges — /i/ has F1 near 270 Hz and /ɑ/ near 730 Hz, and a
 * boundary placed anywhere between them will split one vowel or merge two.
 */
const VOWEL_PROTOTYPES: Array<[Viseme, number, number]> = [
  ['I',  280, 2250], // "see"
  ['E',  530, 1840], // "bed"
  ['aa', 730, 1100], // "father"
  ['O',  500,  900], // "boat"
  ['U',  320,  800], // "boot"
];

/** Formant search ranges, deliberately overlapping. */
const F1_RANGE: [number, number] = [240, 1000];
const F2_RANGE: [number, number] = [900, 3100];
/** Sibilant energy lives well above either formant. */
const HF_RANGE: [number, number] = [3600, 10500];
const HF_SHARP: [number, number] = [6200, 10500];
/** The fundamental. Excluded from formant estimation — see below. */
const F0_RANGE: [number, number] = [70, 240];

export interface Classified {
  weights: Record<Viseme, number>;
  energy: number;
}

/** Magnitude-squared-weighted centroid over a frequency range, in Hz. */
function centroid(mag: Float32Array, binHz: number, lo: number, hi: number): number {
  const a = Math.max(1, Math.floor(lo / binHz));
  const b = Math.min(mag.length - 1, Math.ceil(hi / binHz));
  let num = 0, den = 0;
  for (let i = a; i <= b; i++) {
    const w = mag[i] * mag[i];
    num += w * i * binHz;
    den += w;
  }
  return den > 1e-12 ? num / den : (lo + hi) / 2;
}

function bandEnergy(mag: Float32Array, binHz: number, lo: number, hi: number): number {
  const a = Math.max(0, Math.floor(lo / binHz));
  const b = Math.min(mag.length - 1, Math.ceil(hi / binHz));
  let s = 0;
  for (let i = a; i <= b; i++) s += mag[i];
  return s / Math.max(1, b - a + 1);
}

/**
 * Classify one spectral frame into overlapping viseme weights.
 *
 * `mag` is a linear magnitude spectrum, `binHz` the width of one bin, and
 * `rms` the time-domain level of the same window (a far better loudness
 * measure than summing bins, whose scale depends on the transform).
 *
 * Note that the fundamental is excluded from the F1 search. An earlier
 * version folded 70–320 Hz into the low-formant measurement, and for a voice
 * with a strong F0 that band dominates everything above it — every vowel came
 * out reading as rounded, so the mouth sat in a permanent "ooh".
 */
export function classifySpectrum(mag: Float32Array, binHz: number, rms: number): Classified {
  const w: Record<Viseme, number> = { aa: 0, E: 0, I: 0, O: 0, U: 0, M: 0, F: 0, S: 0, L: 0 };

  const energy = Math.min(1, rms * 7.5);
  if (energy <= 0.045) return { weights: w, energy };

  const hf = bandEnergy(mag, binHz, HF_RANGE[0], HF_RANGE[1]);
  const voiced = bandEnergy(mag, binHz, F0_RANGE[0], F2_RANGE[1]);
  const sibilance = hf / (hf + voiced + 1e-9);

  if (sibilance > 0.30) {
    // Fricatives. /s ʃ/ carry more of their energy above 6 kHz than /f v/ do,
    // which is what separates a sibilant (teeth close) from a labiodental
    // (lower lip tucked under the teeth).
    const sharp = bandEnergy(mag, binHz, HF_SHARP[0], HF_SHARP[1]) / (hf + 1e-9);
    const strength = Math.min(1, (sibilance - 0.24) * 3.0);
    w.S = strength * Math.min(1, sharp * 1.35);
    w.F = strength * (1 - Math.min(1, sharp * 1.35));
    w.E = 0.14;
  } else {
    const f1 = centroid(mag, binHz, F1_RANGE[0], F1_RANGE[1]);
    const f2 = centroid(mag, binHz, F2_RANGE[0], F2_RANGE[1]);

    // Distance in log-frequency, which matches how formant differences are
    // actually perceived, then a soft assignment so neighbouring vowels blend
    // instead of snapping.
    let total = 0;
    const scores: Array<[Viseme, number]> = [];
    for (const [v, p1, p2] of VOWEL_PROTOTYPES) {
      const d1 = Math.log2(f1 / p1);
      const d2 = Math.log2(f2 / p2);
      const d = Math.sqrt(d1 * d1 + d2 * d2 * 1.25);
      const score = Math.exp(-(d * d) / (2 * 0.30 * 0.30));
      scores.push([v, score]);
      total += score;
    }
    const vowel = 1 - Math.min(1, sibilance * 2.0);
    for (const [v, score] of scores) w[v] = (score / (total + 1e-9)) * vowel;

    // A touch of alveolar under everything keeps the mouth from freezing on a
    // long steady tone.
    w.L = vowel * 0.10;
  }

  let sum = 0;
  for (const v of VISEMES) sum += w[v];
  if (sum > 1) for (const v of VISEMES) w[v] /= sum;

  const gain = Math.min(1, energy * 1.6);
  for (const v of VISEMES) w[v] *= gain;

  return { weights: w, energy };
}

/**
 * Viseme → Action Unit mapping.
 *
 * Each viseme names the posture it produces. Weights are additive and clamped
 * downstream, so overlapping visemes blend the way coarticulated speech does.
 */
export const VISEME_TO_AU: Record<Viseme, Partial<Record<string, number>>> = {
  // /ɑ/ — jaw drops, lips relaxed and slightly wide
  aa: { jawOpen: 0.92, lipsPart: 0.62, lipStretch: 0.12, mtMouthOpen: 0.40 },
  // /ɛ/ — mid-open, corners drawn out
  E: { jawOpen: 0.46, lipsPart: 0.56, lipStretch: 0.38, mtMouthOpen: 0.20 },
  // /i/ — barely open, lips spread hard
  I: { jawOpen: 0.16, lipsPart: 0.46, lipStretch: 0.70, mtMouthSmile: 0.20 },
  // /o/ — rounded and open
  O: { jawOpen: 0.48, lipPucker: 0.62, jawThrust: 0.24, lipsPart: 0.32 },
  // /u/ — tight round purse
  U: { jawOpen: 0.15, lipPucker: 0.96, jawThrust: 0.34 },
  // /m b p/ — full bilabial closure
  M: { jawOpen: 0.0, lipsPress: 0.85, lipsPart: -0.30 },
  // /f v/ — lower lip to upper teeth
  F: { jawOpen: 0.12, lipsPress: 0.40, upperLipRaise: 0.26, lipStretch: 0.16 },
  // /s z ʃ/ — teeth nearly closed, lips tense and wide
  S: { jawOpen: 0.11, lipStretch: 0.48, lipsPart: 0.28 },
  // /l n d t/ — small neutral aperture
  L: { jawOpen: 0.32, lipsPart: 0.62 },
};
