import { AU_NAMES, type AUName } from './faceRig';

/**
 * expression.ts — the layer that decides what the face is *doing*.
 *
 * Three things happen here:
 *
 *   1. Emotions are defined as Action Unit combinations, the way FACS
 *      describes real expressions, so they compose instead of replacing
 *      each other. Speech can run on top of an emotion because visemes and
 *      emotions write to mostly disjoint AU sets.
 *
 *   2. Involuntary behaviour — blinks, saccades, breathing, idle head
 *      drift. This is most of what separates "a 3D face" from "someone is
 *      in there". A perfectly still face reads as dead within two seconds.
 *
 *   3. Asymmetry. Symmetric faces are the single biggest uncanny-valley
 *      tell. Every face here gets a small permanent bias, and expressions
 *      lead on one side by a few tens of milliseconds.
 */

export type Emotion =
  | 'neutral' | 'attentive' | 'thinking' | 'pleased'
  | 'curious' | 'concerned' | 'surprised' | 'dormant';

export type AUMap = Partial<Record<AUName, number>>;

/**
 * Emotion presets. Note that several deliberately break symmetry — a curious
 * face raises one brow, not two, and a genuine smile is never even.
 */
export const EMOTIONS: Record<Emotion, AUMap> = {
  dormant: {
    browInnerUpL: 0.05, browInnerUpR: 0.05,
    squintL: 0.30, squintR: 0.30,
    lipsPress: 0.12,
  },
  neutral: {
    browOuterUpL: 0.05, browOuterUpR: 0.04,
    lipCornerPullL: 0.06, lipCornerPullR: 0.05,
  },
  attentive: {
    browInnerUpL: 0.18, browInnerUpR: 0.16,
    browOuterUpL: 0.24, browOuterUpR: 0.22,
    eyeWideL: 0.26, eyeWideR: 0.24,
    lipCornerPullL: 0.10, lipCornerPullR: 0.08,
  },
  thinking: {
    browLowerL: 0.30, browLowerR: 0.22,
    browInnerUpL: 0.20, browInnerUpR: 0.12,
    squintL: 0.24, squintR: 0.20,
    lipsPress: 0.22, lipPucker: 0.14,
  },
  pleased: {
    // AU12 + AU6 together — the Duchenne pair. Without the cheek raise this
    // reads as the polite smile people instinctively distrust.
    lipCornerPullL: 0.72, lipCornerPullR: 0.66,
    cheekRaiseL: 0.55, cheekRaiseR: 0.50,
    squintL: 0.34, squintR: 0.30,
    browOuterUpL: 0.18, browOuterUpR: 0.16,
    lipsPart: 0.16,
  },
  curious: {
    browInnerUpL: 0.52, browOuterUpL: 0.60,
    browInnerUpR: 0.10, browOuterUpR: 0.06,
    eyeWideL: 0.22, eyeWideR: 0.14,
    lipCornerPullL: 0.20, lipCornerPullR: 0.12,
  },
  concerned: {
    browInnerUpL: 0.62, browInnerUpR: 0.58,
    browLowerL: 0.22, browLowerR: 0.20,
    lipCornerDropL: 0.28, lipCornerDropR: 0.24,
    lipsPress: 0.18,
  },
  surprised: {
    browInnerUpL: 0.70, browInnerUpR: 0.66,
    browOuterUpL: 0.80, browOuterUpR: 0.76,
    eyeWideL: 0.78, eyeWideR: 0.74,
    jawOpen: 0.22, lipsPart: 0.30,
  },
};

// ── Value noise ────────────────────────────────────────────────────────
// Idle motion driven by sine waves reads as mechanical: it has an obvious
// period and it returns to the same pose forever. Layered value noise
// wanders instead, which is what heads actually do.

function hash(n: number): number {
  const s = Math.sin(n * 127.1) * 43758.5453;
  return s - Math.floor(s);
}

function vnoise(x: number): number {
  const i = Math.floor(x);
  const f = x - i;
  const u = f * f * (3 - 2 * f);
  return (hash(i) * (1 - u) + hash(i + 1) * u) * 2 - 1;
}

export function fbm(x: number, octaves = 3): number {
  let v = 0, amp = 0.5, freq = 1;
  for (let i = 0; i < octaves; i++) {
    v += vnoise(x * freq) * amp;
    freq *= 2.03;
    amp *= 0.5;
  }
  return v;
}

// ── Blinks ─────────────────────────────────────────────────────────────

export class BlinkController {
  /** 0 = open, 1 = fully closed, per eye. */
  left = 0;
  right = 0;
  private timer = 1.2;
  private phase: 'idle' | 'closing' | 'opening' = 'idle';
  private t = 0;
  private queued = 0;
  private lead = 0; // which eye leads this blink, in seconds

  /** Higher when thinking — blink rate genuinely rises under cognitive load. */
  rate = 1;

  update(dt: number) {
    if (this.phase === 'idle') {
      this.timer -= dt * this.rate;
      if (this.timer <= 0) this.start();
    } else {
      this.t += dt;
      // Closing is much faster than opening — a real blink is roughly
      // 90 ms down, 150 ms back up.
      if (this.phase === 'closing') {
        const p = Math.min(1, this.t / 0.085);
        this.set(p);
        if (p >= 1) { this.phase = 'opening'; this.t = 0; }
      } else {
        const p = Math.min(1, this.t / 0.155);
        this.set(1 - p * p);
        if (p >= 1) {
          this.phase = 'idle';
          this.t = 0;
          if (this.queued > 0) { this.queued--; this.timer = 0.09; }
          else this.timer = this.nextInterval();
        }
      }
    }
  }

  private set(v: number) {
    this.left = Math.max(0, Math.min(1, v));
    // The lagging eye trails by a few frames. Imperceptible individually,
    // but it removes the "two shutters on one motor" look.
    this.right = Math.max(0, Math.min(1, v - this.lead));
  }

  private start() {
    this.phase = 'closing';
    this.t = 0;
    this.lead = (Math.random() - 0.5) * 0.10;
    // Humans double-blink maybe a fifth of the time.
    if (Math.random() < 0.18) this.queued = 1;
  }

  private nextInterval(): number {
    // Blink intervals are roughly log-normal around 3–4 s, not uniform.
    return 1.9 + Math.abs(fbm(Math.random() * 90)) * 2.2 + Math.random() * 2.4;
  }

  /** Force a blink now — used on state changes, which is when people blink. */
  trigger() {
    if (this.phase === 'idle') this.start();
  }
}

// ── Gaze ───────────────────────────────────────────────────────────────

export type GazeTarget = 'viewer' | 'canvas' | 'away' | 'wander';

/**
 * Eyes move in saccades — fast jumps between fixations, never smooth pans
 * (outside of tracking a moving object). Between saccades there is a
 * constant low-amplitude tremor. Both are reproduced here because a
 * perfectly steady eye is the fastest way to look synthetic.
 */
export class GazeController {
  /** Current gaze offset in radians, applied to the eyes. */
  x = 0;
  y = 0;
  /** Where the head should follow to, a damped fraction of gaze. */
  headX = 0;
  headY = 0;

  private tx = 0;
  private ty = 0;
  private fromX = 0;
  private fromY = 0;
  private saccadeT = 1;
  private saccadeDur = 0.05;
  private fixation = 0.6;
  private t = 0;

  target: GazeTarget = 'viewer';
  /** Optional explicit point in normalised screen space, -1..1. */
  point: [number, number] | null = null;

  update(dt: number) {
    this.t += dt;
    this.fixation -= dt;

    if (this.fixation <= 0 && this.saccadeT >= 1) this.newSaccade();

    if (this.saccadeT < 1) {
      this.saccadeT = Math.min(1, this.saccadeT + dt / this.saccadeDur);
      // Saccades have a characteristic fast-out profile.
      const e = 1 - Math.pow(1 - this.saccadeT, 3);
      this.x = this.fromX + (this.tx - this.fromX) * e;
      this.y = this.fromY + (this.ty - this.fromY) * e;
    }

    // Ocular microtremor during fixation.
    const tremor = 0.0045;
    const jx = fbm(this.t * 7.3, 2) * tremor;
    const jy = fbm(this.t * 6.1 + 30, 2) * tremor;

    const gx = this.x + jx;
    const gy = this.y + jy;

    // The head follows the eyes, lagging and under-rotating — you turn your
    // eyes first and your head catches up part of the way.
    this.headX += (gx * 0.42 - this.headX) * (1 - Math.exp(-dt / 0.38));
    this.headY += (gy * 0.30 - this.headY) * (1 - Math.exp(-dt / 0.45));

    this.x = gx;
    this.y = gy;
  }

  private newSaccade() {
    this.fromX = this.x;
    this.fromY = this.y;

    let bx = 0, by = 0, spread = 0.10;
    switch (this.target) {
      case 'viewer': bx = 0; by = 0; spread = 0.055; break;
      case 'canvas': bx = -0.30; by = -0.06; spread = 0.075; break;
      // Gaze aversion during thought skews up and to one side; it is a real
      // and very readable signal that processing is happening.
      case 'away': bx = 0.26; by = 0.20; spread = 0.10; break;
      case 'wander': bx = 0; by = 0; spread = 0.22; break;
    }
    if (this.point) { bx = this.point[0] * 0.30; by = this.point[1] * 0.20; spread = 0.03; }

    this.tx = bx + (Math.random() * 2 - 1) * spread;
    this.ty = by + (Math.random() * 2 - 1) * spread * 0.7;

    const dist = Math.hypot(this.tx - this.fromX, this.ty - this.fromY);
    // Saccade duration scales with amplitude (the main sequence).
    this.saccadeDur = 0.022 + dist * 0.10;
    this.saccadeT = 0;
    this.fixation = this.target === 'viewer'
      ? 0.5 + Math.random() * 1.5
      : 0.25 + Math.random() * 0.9;
  }

  look(target: GazeTarget) {
    if (this.target !== target) {
      this.target = target;
      this.fixation = 0; // re-fixate immediately on a state change
    }
  }
}

// ── AU animator ────────────────────────────────────────────────────────

/**
 * Holds the live AU weights and eases them toward whatever the emotion and
 * speech layers request. Attack and release are separate because faces
 * tense faster than they relax.
 */
export class AUAnimator {
  current: Record<string, number> = {};
  private target: Record<string, number> = {};
  /** Small permanent per-side bias so the face is never mirror-symmetric. */
  private bias: Record<string, number> = {};

  constructor() {
    for (const n of AU_NAMES) {
      this.current[n] = 0;
      this.target[n] = 0;
      this.bias[n] = 0;
    }
    const b = (n: AUName, v: number) => { this.bias[n] = v; };
    b('browOuterUpL', 0.035);
    b('browInnerUpR', 0.022);
    b('lipCornerPullL', 0.030);
    b('squintR', 0.020);
  }

  clearTargets() {
    for (const n of AU_NAMES) this.target[n] = this.bias[n];
  }

  /** Additively request AU weights. Later calls stack onto earlier ones. */
  add(map: AUMap | Partial<Record<string, number>>, gain = 1) {
    for (const k in map) {
      const v = (map as Record<string, number>)[k];
      if (v === undefined) continue;
      this.target[k] = (this.target[k] ?? 0) + v * gain;
    }
  }

  set(name: AUName, v: number) {
    this.target[name] = v;
  }

  update(dt: number) {
    for (const n of AU_NAMES) {
      const t = Math.max(-0.5, Math.min(1.35, this.target[n] ?? 0));
      const c = this.current[n];
      const tau = t > c ? 0.055 : 0.105;
      this.current[n] = c + (t - c) * (1 - Math.exp(-dt / tau));
    }
  }
}

// ── Breathing ──────────────────────────────────────────────────────────

export class Breath {
  private t = 0;
  /** Vertical bob, in normalised head units. */
  offset = 0;
  /** Subtle overall scale — the chest rise read through the head. */
  scale = 1;

  update(dt: number, intensity: number) {
    // Speaking shortens and shallows the breath cycle.
    const period = 4.2 - intensity * 1.4;
    this.t += dt / period;
    const s = Math.sin(this.t * Math.PI * 2);
    // Asymmetric: inhale is quicker than exhale.
    const shaped = s > 0 ? Math.pow(s, 0.75) : -Math.pow(-s, 1.35);
    this.offset = shaped * 0.020;
    this.scale = 1 + shaped * 0.0055;
  }
}
