import * as THREE from 'three';

/**
 * faceRig.ts — turns the Ready Player Me head mesh into an animatable
 * holographic point cloud with a procedural FACS-style blendshape rig.
 *
 * Why this exists
 * ---------------
 * The head.glb we ship is a stock RPM export. It carries exactly TWO morph
 * targets — `mouthOpen` and `mouthSmile`. That is nowhere near enough to
 * drive a face that reads as alive, so instead of relying on the asset we
 * *synthesise* a rig:
 *
 *   1. Resample the mesh surface into an even blue-noise dot field, denser
 *      around the features that carry expression (eyes, brows, mouth, nose).
 *   2. For each anatomical Action Unit (brow raise, lip corner pull, jaw
 *      rotation, cheek raise …) precompute a sparse displacement basis —
 *      the exact offset every affected dot takes at full activation.
 *   3. At runtime the animator just accumulates `base + Σ wᵢ · Δᵢ`, which is
 *      standard blendshape blending over a rig we generated ourselves.
 *
 * The two real morph targets are resampled through the same barycentric
 * interpolation and folded in as two more basis vectors, so authored
 * anatomy and procedural anatomy blend in the same pass.
 *
 * Everything here runs once, at load.
 */

// ── Anatomy ────────────────────────────────────────────────────────────
// Measured directly off head.glb, in the model's own units (metres, with
// the head sitting at roughly eye height on a 1.8 m body). +Y up, +Z out
// through the nose, +X toward the character's own left.

export const L = {
  eyeL: v(0.0303, 1.7261, 0.0973),
  eyeR: v(-0.0303, 1.7261, 0.0973),
  eyeRadius: 0.0192,

  browL: v(0.0335, 1.7530, 0.1005),
  browR: v(-0.0335, 1.7530, 0.1005),

  noseTip: v(0, 1.6921, 0.1467),
  noseBridge: v(0, 1.7360, 0.1140),
  nostrilL: v(0.0145, 1.6835, 0.1240),
  nostrilR: v(-0.0145, 1.6835, 0.1240),

  mouthCenter: v(0, 1.6540, 0.1240),
  upperLip: v(0, 1.6592, 0.1268),
  lowerLip: v(0, 1.6486, 0.1246),
  cornerL: v(0.0422, 1.6697, 0.1054),
  cornerR: v(-0.0422, 1.6697, 0.1054),

  cheekL: v(0.0625, 1.6905, 0.0815),
  cheekR: v(-0.0625, 1.6905, 0.0815),

  chin: v(0, 1.6115, 0.1150),
  jawHinge: v(0, 1.7150, -0.0160), // mandibular condyle — the jaw pivots here

  headTop: 1.8331,
} as const;

/**
 * Where the head stops and the neck begins, as a function of depth.
 *
 * A flat horizontal cut cannot do this: at y = 1.61 the mesh contains both
 * the chin (forward, z ≈ 0.115) and the throat (behind it, z ≈ 0.05), so any
 * single height either leaves a neck stub or eats the chin. The real boundary
 * tilts — lowest at the chin in front, rising toward the nape at the back.
 */
export function jawlineY(z: number): number {
  return 1.6285 - 0.168 * z;
}

/** Depth of the dissolve below the jawline. The head fades out; it is not cut. */
const JAW_FADE = 0.046;

type V3 = { x: number; y: number; z: number };
function v(x: number, y: number, z: number): V3 {
  return { x, y, z };
}

// ── Small maths helpers ────────────────────────────────────────────────

/** Deterministic RNG — the face must be the same character every load. */
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function smoothstep(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0 || 1e-9)));
  return t * t * (3 - 2 * t);
}

/** 1 at the centre, 0 at/outside the ellipsoid boundary, smooth between. */
function field(
  px: number, py: number, pz: number,
  c: V3, rx: number, ry: number, rz: number,
  power = 1,
): number {
  const dx = (px - c.x) / rx;
  const dy = (py - c.y) / ry;
  const dz = (pz - c.z) / rz;
  const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
  const w = 1 - smoothstep(0, 1, d);
  return power === 1 ? w : Math.pow(w, power);
}

// ── Public shape ───────────────────────────────────────────────────────

/** A sparse displacement basis: `idx[k]` moves by `delta[3k..3k+2]` at w=1. */
export interface AUBasis {
  idx: Uint32Array;
  delta: Float32Array;
}

export type AUName =
  | 'jawOpen' | 'jawThrust' | 'jawShiftL' | 'jawShiftR'
  | 'lipCornerPullL' | 'lipCornerPullR'
  | 'lipCornerDropL' | 'lipCornerDropR'
  | 'lipPucker' | 'lipStretch' | 'lipsPress' | 'lipsPart'
  | 'upperLipRaise' | 'lowerLipDown'
  | 'browInnerUpL' | 'browInnerUpR'
  | 'browOuterUpL' | 'browOuterUpR'
  | 'browLowerL' | 'browLowerR'
  | 'cheekRaiseL' | 'cheekRaiseR'
  | 'squintL' | 'squintR'
  | 'eyeWideL' | 'eyeWideR'
  | 'noseWrinkle'
  | 'mtMouthOpen' | 'mtMouthSmile';

export const AU_NAMES: AUName[] = [
  'jawOpen', 'jawThrust', 'jawShiftL', 'jawShiftR',
  'lipCornerPullL', 'lipCornerPullR', 'lipCornerDropL', 'lipCornerDropR',
  'lipPucker', 'lipStretch', 'lipsPress', 'lipsPart',
  'upperLipRaise', 'lowerLipDown',
  'browInnerUpL', 'browInnerUpR', 'browOuterUpL', 'browOuterUpR',
  'browLowerL', 'browLowerR',
  'cheekRaiseL', 'cheekRaiseR', 'squintL', 'squintR',
  'eyeWideL', 'eyeWideR', 'noseWrinkle',
  'mtMouthOpen', 'mtMouthSmile',
];

export interface FaceRig {
  /** Rest positions, centred on the head and scaled to ~2 units tall. */
  base: Float32Array;
  normal: Float32Array;
  /** Per-dot [0..1] random, for flicker and size variation. */
  seed: Float32Array;
  /** Baked-in opacity — carries the dissolve at the base of the head. */
  alpha: Float32Array;
  /** Feature weight [0..1] — 1 on eyes/mouth, low on the cranium. */
  feature: Float32Array;
  count: number;

  aus: Record<AUName, AUBasis>;

  /** Eyes are their own cloud so they can rotate for gaze independently. */
  eye: {
    base: Float32Array;
    normal: Float32Array;
    seed: Float32Array;
    /** 0 = sclera, 1 = iris, 2 = pupil. Drives colour and brightness. */
    part: Uint8Array;
    /** 0 = character's left eye, 1 = right. */
    side: Uint8Array;
    count: number;
    centerL: [number, number, number];
    centerR: [number, number, number];
    radius: number;
  };

  /** Everything below is post-transform (centred + scaled), for the animator. */
  xf: {
    center: [number, number, number];
    scale: number;
    /** Landmarks pushed through the same transform. */
    lm: Record<string, [number, number, number]>;
  };
}

// ── Surface sampling ───────────────────────────────────────────────────

interface Tri {
  a: number; b: number; c: number; // vertex indices
  area: number;
}

/**
 * How much dot budget a region deserves. Expression lives in the eyes,
 * brows and mouth; the cranium is a smooth dome that reads fine sparse.
 * Returning >1 means "pack dots tighter here".
 */
const MIN_IMPORTANCE = 0.55;

function importanceAt(x: number, y: number, z: number): number {
  let w = MIN_IMPORTANCE;
  w = Math.max(w, 1.00 * field(x, y, z, L.mouthCenter, 0.075, 0.040, 0.070));
  w = Math.max(w, 0.98 * field(x, y, z, L.eyeL, 0.040, 0.030, 0.045));
  w = Math.max(w, 0.98 * field(x, y, z, L.eyeR, 0.040, 0.030, 0.045));
  w = Math.max(w, 0.82 * field(x, y, z, L.browL, 0.048, 0.024, 0.045));
  w = Math.max(w, 0.82 * field(x, y, z, L.browR, 0.048, 0.024, 0.045));
  w = Math.max(w, 0.80 * field(x, y, z, L.noseTip, 0.032, 0.048, 0.045));
  w = Math.max(w, 0.66 * field(x, y, z, L.chin, 0.055, 0.045, 0.055));
  return w;
}

interface SampledPoint {
  x: number; y: number; z: number;
  nx: number; ny: number; nz: number;
  /** Barycentric-interpolated morph target deltas, when present. */
  mo: [number, number, number];
  ms: [number, number, number];
}

/**
 * Variable-radius Poisson-disk (dart-throwing) sampling over a mesh surface.
 *
 * Plain `Math.random()` sampling — what the previous implementation used —
 * gives white noise: clumps and holes. It reads as static rather than as a
 * projection. Blue noise gives an even, deliberate matrix, which is the whole
 * visual premise of the effect.
 */
function sampleSurface(
  pos: Float32Array,
  nor: Float32Array | null,
  morphOpen: Float32Array | null,
  morphSmile: Float32Array | null,
  index: ArrayLike<number> | null,
  target: number,
  rng: () => number,
): SampledPoint[] {
  const tris: Tri[] = [];
  const push = (a: number, b: number, c: number) => {
    const ax = pos[a * 3], ay = pos[a * 3 + 1], az = pos[a * 3 + 2];
    const bx = pos[b * 3], by = pos[b * 3 + 1], bz = pos[b * 3 + 2];
    const cx = pos[c * 3], cy = pos[c * 3 + 1], cz = pos[c * 3 + 2];
    const ux = bx - ax, uy = by - ay, uz = bz - az;
    const wx = cx - ax, wy = cy - ay, wz = cz - az;
    const nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
    const area = 0.5 * Math.hypot(nx, ny, nz);
    if (area > 1e-12) tris.push({ a, b, c, area });
  };

  if (index) {
    for (let i = 0; i + 2 < index.length; i += 3) push(index[i], index[i + 1], index[i + 2]);
  } else {
    for (let i = 0; i + 2 < pos.length / 3; i += 3) push(i, i + 1, i + 2);
  }
  if (!tris.length) return [];

  // Prefix sums for O(log n) area-weighted triangle selection.
  const cdf = new Float64Array(tris.length);
  let total = 0;
  for (let i = 0; i < tris.length; i++) {
    total += tris[i].area;
    cdf[i] = total;
  }
  const pickTri = () => {
    const r = rng() * total;
    let lo = 0, hi = tris.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cdf[mid] < r) lo = mid + 1; else hi = mid;
    }
    return tris[lo];
  };

  // Calibrate the base spacing.
  //
  // Each accepted dot claims about r(p)²/K of surface, and r(p) scales as
  // rBase/importance, so the total area works out to N·rBase²·mean(1/imp²)/K.
  // Solving that for rBase is what makes the dot budget land on target instead
  // of undershooting by 4x once the feature regions take their share.
  let impAcc = 0;
  const probes = 1200;
  for (let i = 0; i < probes; i++) {
    const t = pickTri();
    let u = rng(), w2 = rng();
    if (u + w2 > 1) { u = 1 - u; w2 = 1 - w2; }
    const bc = [1 - u - w2, u, w2];
    const vi = [t.a, t.b, t.c];
    let x = 0, y = 0, z = 0;
    for (let i2 = 0; i2 < 3; i2++) {
      const o = vi[i2] * 3;
      x += bc[i2] * pos[o]; y += bc[i2] * pos[o + 1]; z += bc[i2] * pos[o + 2];
    }
    const imp = importanceAt(x, y, z);
    impAcc += 1 / (imp * imp);
  }
  const meanInvImp2 = impAcc / probes;
  const K = 0.65; // measured dart-throwing packing efficiency

  let rBase = Math.sqrt((K * total) / (target * meanInvImp2));
  let out: SampledPoint[] = [];

  // Dart-throwing is stochastic; one corrective pass pulls the count onto
  // target if the first run drifts.
  for (let pass = 0; pass < 2; pass++) {
    out = dartThrow(rBase);
    if (out.length >= target * 0.9) break;
    rBase *= Math.sqrt(Math.max(0.4, out.length / target));
  }
  return out;

  function dartThrow(rB: number): SampledPoint[] {
    // Flat integer-indexed grid with a head/next linked list — no Map, no
    // string keys, no per-candidate allocation. This is the whole cost of
    // the build, so it is worth doing properly.
    const rMax = rB / MIN_IMPORTANCE;
    const cell = rMax;
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let i = 0; i < pos.length; i += 3) {
      if (pos[i] < minX) minX = pos[i];
      if (pos[i] > maxX) maxX = pos[i];
      if (pos[i + 1] < minY) minY = pos[i + 1];
      if (pos[i + 1] > maxY) maxY = pos[i + 1];
      if (pos[i + 2] < minZ) minZ = pos[i + 2];
      if (pos[i + 2] > maxZ) maxZ = pos[i + 2];
    }
    const pad = cell * 2;
    const nx = Math.max(1, Math.ceil((maxX - minX + pad * 2) / cell));
    const ny = Math.max(1, Math.ceil((maxY - minY + pad * 2) / cell));
    const nz = Math.max(1, Math.ceil((maxZ - minZ + pad * 2) / cell));
    const head = new Int32Array(nx * ny * nz).fill(-1);
    const next = new Int32Array(target + 1).fill(-1);
    const gi = (x: number, y: number, z: number) => {
      const a = Math.min(nx - 1, Math.max(0, ((x - minX + pad) / cell) | 0));
      const b = Math.min(ny - 1, Math.max(0, ((y - minY + pad) / cell) | 0));
      const c = Math.min(nz - 1, Math.max(0, ((z - minZ + pad) / cell) | 0));
      return (c * ny + b) * nx + a;
    };

    const out: SampledPoint[] = [];
    const px = new Float32Array(target);
    const py = new Float32Array(target);
    const pz = new Float32Array(target);
    const radii = new Float32Array(target);
    const attempts = target * 22;

    for (let k = 0; k < attempts && out.length < target; k++) {
      const t = pickTri();
      let u = rng(), w2 = rng();
      if (u + w2 > 1) { u = 1 - u; w2 = 1 - w2; }
      const bc = [1 - u - w2, u, w2];
      const vi = [t.a, t.b, t.c];

      let x = 0, y = 0, z = 0;
      for (let i = 0; i < 3; i++) {
        const o = vi[i] * 3;
        x += bc[i] * pos[o]; y += bc[i] * pos[o + 1]; z += bc[i] * pos[o + 2];
      }

      // Variable-radius rejection: the dot must clear both its own spacing
      // requirement and that of every neighbour already placed.
      const rHere = rB / importanceAt(x, y, z);
      const ax = Math.min(nx - 1, Math.max(0, ((x - minX + pad) / cell) | 0));
      const ay = Math.min(ny - 1, Math.max(0, ((y - minY + pad) / cell) | 0));
      const az = Math.min(nz - 1, Math.max(0, ((z - minZ + pad) / cell) | 0));
      let ok = true;
      for (let c = Math.max(0, az - 1); c <= Math.min(nz - 1, az + 1) && ok; c++)
        for (let b = Math.max(0, ay - 1); b <= Math.min(ny - 1, ay + 1) && ok; b++)
          for (let a = Math.max(0, ax - 1); a <= Math.min(nx - 1, ax + 1) && ok; a++) {
            let j = head[(c * ny + b) * nx + a];
            while (j !== -1) {
              const dx = px[j] - x, dy = py[j] - y, dz = pz[j] - z;
              const lim = rHere > radii[j] ? rHere : radii[j];
              if (dx * dx + dy * dy + dz * dz < lim * lim) { ok = false; break; }
              j = next[j];
            }
          }
      if (!ok) continue;

      let nX = 0, nY = 0, nZ = 0;
      if (nor) {
        for (let i = 0; i < 3; i++) {
          const o = vi[i] * 3;
          nX += bc[i] * nor[o]; nY += bc[i] * nor[o + 1]; nZ += bc[i] * nor[o + 2];
        }
      } else {
        const bx = pos[t.a * 3], by = pos[t.a * 3 + 1], bz = pos[t.a * 3 + 2];
        const ux = pos[t.b * 3] - bx, uy = pos[t.b * 3 + 1] - by, uz = pos[t.b * 3 + 2] - bz;
        const wx = pos[t.c * 3] - bx, wy = pos[t.c * 3 + 1] - by, wz = pos[t.c * 3 + 2] - bz;
        nX = uy * wz - uz * wy; nY = uz * wx - ux * wz; nZ = ux * wy - uy * wx;
      }
      const nl = Math.hypot(nX, nY, nZ) || 1;

      const lerpMorph = (m: Float32Array | null): [number, number, number] => {
        if (!m) return [0, 0, 0];
        let dx = 0, dy = 0, dz = 0;
        for (let i = 0; i < 3; i++) {
          const o = vi[i] * 3;
          dx += bc[i] * m[o]; dy += bc[i] * m[o + 1]; dz += bc[i] * m[o + 2];
        }
        return [dx, dy, dz];
      };

      const idx = out.length;
      out.push({
        x, y, z,
        nx: nX / nl, ny: nY / nl, nz: nZ / nl,
        mo: lerpMorph(morphOpen),
        ms: lerpMorph(morphSmile),
      });
      px[idx] = x; py[idx] = y; pz[idx] = z; radii[idx] = rHere;
      const g = gi(x, y, z);
      next[idx] = head[g];
      head[g] = idx;
    }

    return out;
  }
}

// ── Action Unit construction ───────────────────────────────────────────

class BasisBuilder {
  private idx: number[] = [];
  private delta: number[] = [];
  add(i: number, dx: number, dy: number, dz: number) {
    if (Math.abs(dx) + Math.abs(dy) + Math.abs(dz) < 1e-7) return;
    this.idx.push(i);
    this.delta.push(dx, dy, dz);
  }
  build(): AUBasis {
    return { idx: Uint32Array.from(this.idx), delta: Float32Array.from(this.delta) };
  }
}

/** Rotate `p` about an X-parallel axis through `pivot`. */
function rotX(py: number, pz: number, pivot: V3, ang: number): [number, number] {
  const dy = py - pivot.y, dz = pz - pivot.z;
  const c = Math.cos(ang), s = Math.sin(ang);
  return [pivot.y + dy * c - dz * s, pivot.z + dy * s + dz * c];
}

/**
 * Bakes every Action Unit into a sparse displacement basis.
 *
 * Amplitudes are in model units (metres) — they get scaled with everything
 * else afterwards, so the numbers here are real anatomical travel distances.
 */
function buildActionUnits(pts: SampledPoint[]): Record<AUName, AUBasis> {
  const b: Record<string, BasisBuilder> = {};
  for (const n of AU_NAMES) b[n] = new BasisBuilder();

  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const { x, y, z } = p;
    const left = x > 0; // character's left
    const sideL = smoothstep(-0.012, 0.012, x);       // 0 on the right, 1 on the left
    const sideR = 1 - sideL;

    // ── Jaw ─────────────────────────────────────────────────────────
    // The mandible ROTATES about the condyles. The previous build slid the
    // whole lower third of the head straight down, which detached the chin.
    // Rotation gives the correct gradient for free: dots near the hinge
    // barely move, the chin swings.
    const jawMask =
      smoothstep(L.mouthCenter.y + 0.020, L.chin.y - 0.005, y) *
      (1 - 0.55 * smoothstep(-0.02, -0.075, z)); // taper toward the skull base
    if (jawMask > 0.001) {
      const ang = 0.30; // ~17° at full open
      const [ny2, nz2] = rotX(y, z, L.jawHinge, ang);
      b.jawOpen.add(i, 0, (ny2 - y) * jawMask, (nz2 - z) * jawMask);
      b.jawThrust.add(i, 0, 0, 0.016 * jawMask);
      b.jawShiftL.add(i, 0.010 * jawMask, 0, 0);
      b.jawShiftR.add(i, -0.010 * jawMask, 0, 0);
    }

    // ── Mouth ───────────────────────────────────────────────────────
    const nearMouth = field(x, y, z, L.mouthCenter, 0.082, 0.046, 0.075, 0.85);
    const cornerLw = field(x, y, z, L.cornerL, 0.040, 0.032, 0.042);
    const cornerRw = field(x, y, z, L.cornerR, 0.040, 0.032, 0.042);

    if (cornerLw > 0.001) {
      // AU12 — corner travels up, out, and back around the dental arch.
      b.lipCornerPullL.add(i, 0.0135 * cornerLw, 0.0150 * cornerLw, -0.0055 * cornerLw);
      b.lipCornerDropL.add(i, 0.0020 * cornerLw, -0.0130 * cornerLw, -0.0015 * cornerLw);
    }
    if (cornerRw > 0.001) {
      b.lipCornerPullR.add(i, -0.0135 * cornerRw, 0.0150 * cornerRw, -0.0055 * cornerRw);
      b.lipCornerDropR.add(i, -0.0020 * cornerRw, -0.0130 * cornerRw, -0.0015 * cornerRw);
    }

    if (nearMouth > 0.001) {
      const dx = x - L.mouthCenter.x;
      const dy = y - L.mouthCenter.y;
      // AU18 — purse: everything converges on the mouth axis and pushes out.
      b.lipPucker.add(i, -dx * 0.62 * nearMouth, -dy * 0.22 * nearMouth, 0.0135 * nearMouth);
      // AU20 — stretch: the opposite, corners driven wide and flat.
      b.lipStretch.add(i, dx * 0.42 * nearMouth, -dy * 0.10 * nearMouth, -0.0075 * nearMouth);
      // AU24 — press: lips flatten toward the seam and thin out.
      b.lipsPress.add(i, 0, -dy * 0.42 * nearMouth, -0.0040 * nearMouth);
    }

    // Independent upper / lower lip control — this is what separates a real
    // viseme from a hinge. `lipsPart` opens the seam without moving the jaw,
    // which is exactly what /m/ → /b/ release and sibilants need.
    const upper = field(x, y, z, L.upperLip, 0.055, 0.017, 0.052);
    const lower = field(x, y, z, L.lowerLip, 0.055, 0.017, 0.052);
    if (upper > 0.001) {
      b.lipsPart.add(i, 0, 0.0052 * upper, 0);
      b.upperLipRaise.add(i, 0, 0.0105 * upper, 0.0020 * upper);
    }
    if (lower > 0.001) {
      b.lipsPart.add(i, 0, -0.0068 * lower, 0);
      b.lowerLipDown.add(i, 0, -0.0115 * lower, 0.0015 * lower);
    }

    // ── Brows ───────────────────────────────────────────────────────
    // Split inner/outer so we get AU1 vs AU2 separately: inner-only is
    // worry, outer-only is surprise, both is a full raise. Doing this as one
    // "brow" slider is the difference between a face and a puppet.
    const browL = field(x, y, z, L.browL, 0.050, 0.026, 0.048);
    const browR = field(x, y, z, L.browR, 0.050, 0.026, 0.048);
    const innerBias = 1 - smoothstep(0.010, 0.052, Math.abs(x));
    const outerBias = smoothstep(0.012, 0.055, Math.abs(x));

    if (browL > 0.001 && left) {
      b.browInnerUpL.add(i, 0, 0.0135 * browL * innerBias, 0.0018 * browL * innerBias);
      b.browOuterUpL.add(i, 0.0020 * browL * outerBias, 0.0125 * browL * outerBias, 0);
      b.browLowerL.add(i, -0.0055 * browL, -0.0105 * browL, 0.0022 * browL);
    }
    if (browR > 0.001 && !left) {
      b.browInnerUpR.add(i, 0, 0.0135 * browR * innerBias, 0.0018 * browR * innerBias);
      b.browOuterUpR.add(i, -0.0020 * browR * outerBias, 0.0125 * browR * outerBias, 0);
      b.browLowerR.add(i, 0.0055 * browR, -0.0105 * browR, 0.0022 * browR);
    }

    // ── Cheeks (AU6) ────────────────────────────────────────────────
    // The Duchenne marker. A smile without this is the "polite" smile people
    // read as insincere, so every genuine expression pairs AU12 with AU6.
    const chL = field(x, y, z, L.cheekL, 0.052, 0.042, 0.055);
    const chR = field(x, y, z, L.cheekR, 0.052, 0.042, 0.055);
    if (chL > 0.001 && left) b.cheekRaiseL.add(i, 0.0030 * chL, 0.0125 * chL, 0.0055 * chL);
    if (chR > 0.001 && !left) b.cheekRaiseR.add(i, -0.0030 * chR, 0.0125 * chR, 0.0055 * chR);

    // ── Eye aperture ────────────────────────────────────────────────
    const lidL = field(x, y, z, L.eyeL, 0.042, 0.030, 0.046);
    const lidR = field(x, y, z, L.eyeR, 0.042, 0.030, 0.046);
    const above = smoothstep(L.eyeL.y - 0.004, L.eyeL.y + 0.020, y);
    const below = 1 - smoothstep(L.eyeL.y - 0.020, L.eyeL.y + 0.002, y);
    if (lidL > 0.001 && left) {
      b.squintL.add(i, 0, (below * 0.0090 - above * 0.0032) * lidL, 0.0020 * lidL);
      b.eyeWideL.add(i, 0, (above * 0.0075 - below * 0.0045) * lidL, -0.0012 * lidL);
    }
    if (lidR > 0.001 && !left) {
      b.squintR.add(i, 0, (below * 0.0090 - above * 0.0032) * lidR, 0.0020 * lidR);
      b.eyeWideR.add(i, 0, (above * 0.0075 - below * 0.0045) * lidR, -0.0012 * lidR);
    }
    void sideR;

    // ── Nose (AU9) ──────────────────────────────────────────────────
    const nw = field(x, y, z, L.noseTip, 0.030, 0.040, 0.042);
    if (nw > 0.001) b.noseWrinkle.add(i, x * 0.10 * nw, 0.0055 * nw, -0.0030 * nw);

    // ── Authored morph targets, resampled ───────────────────────────
    b.mtMouthOpen.add(i, p.mo[0], p.mo[1], p.mo[2]);
    b.mtMouthSmile.add(i, p.ms[0], p.ms[1], p.ms[2]);
  }

  const out: Record<string, AUBasis> = {};
  for (const n of AU_NAMES) out[n] = b[n].build();
  return out as Record<AUName, AUBasis>;
}

// ── Eyeballs ───────────────────────────────────────────────────────────

/**
 * Eyes get their own cloud so gaze can rotate them without touching the face.
 *
 * The layout matters more than the dot count. These points are drawn with
 * additive blending, which means darkness cannot be drawn — only withheld. A
 * filled disc of lit dots therefore always reads as a headlight, never as an
 * eye. So the pupil is left completely empty, the sclera is a sparse dim
 * scatter, and the dots are concentrated into a bright iris annulus. The
 * result is a dark centre ringed by light, which is what the eye actually
 * looks like and what makes gaze direction legible at this resolution.
 *
 * A small offset catchlight sits over the iris. Real eyes always carry one,
 * and its absence is a surprisingly large part of why synthetic eyes look
 * dead.
 */
function buildEyes(rng: () => number, perEye: number) {
  const base: number[] = [], normal: number[] = [], seed: number[] = [];
  const part: number[] = [], side: number[] = [];

  const GOLDEN = 2.399963229728653;

  for (let s = 0; s < 2; s++) {
    const c = s === 0 ? L.eyeL : L.eyeR;
    const R = L.eyeRadius;

    const place = (localR: number, ang: number, pt: number) => {
      const px = Math.cos(ang) * localR * R;
      const py = Math.sin(ang) * localR * R;
      const pz = Math.sqrt(Math.max(0, R * R - px * px - py * py));
      base.push(c.x + px, c.y + py, c.z + pz - R * 0.16);
      const nl = Math.hypot(px, py, pz) || 1;
      normal.push(px / nl, py / nl, pz / nl);
      seed.push(rng());
      part.push(pt);
      side.push(s);
    };

    // Iris annulus — the bulk of the budget, evenly spread by golden angle.
    const nIris = Math.round(perEye * 0.62);
    for (let i = 0; i < nIris; i++) {
      const t = (i + 0.5) / nIris;
      place(0.30 + 0.22 * Math.sqrt(t), i * GOLDEN + rng() * 0.15, 1);
    }

    // Sclera — sparse and dim, just enough to give the globe an extent.
    const nSclera = perEye - nIris - 3;
    for (let i = 0; i < nSclera; i++) {
      const t = (i + 0.5) / Math.max(1, nSclera);
      place(0.62 + 0.32 * Math.sqrt(t), i * GOLDEN + 1.1 + rng() * 0.25, 0);
    }

    // Catchlight, up and to the character's left.
    for (let i = 0; i < 3; i++) {
      place(0.30 + i * 0.055, 2.30 + i * 0.30, 2);
    }
  }

  return {
    base: new Float32Array(base),
    normal: new Float32Array(normal),
    seed: new Float32Array(seed),
    part: Uint8Array.from(part),
    side: Uint8Array.from(side),
    count: part.length,
  };
}

// ── Entry point ────────────────────────────────────────────────────────

export interface RigOptions {
  /** Face dot budget. ~7000 reads as a surface; drop for weak GPUs. */
  faceDots?: number;
  /** Dots per eye. */
  eyeDots?: number;
}

export function buildFaceRig(scene: THREE.Object3D, opts: RigOptions = {}): FaceRig {
  const faceDots = opts.faceDots ?? 7200;
  const eyeDots = opts.eyeDots ?? 72;
  const rng = mulberry32(0x5ea1f4ce);

  let headGeo: THREE.BufferGeometry | null = null;
  scene.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh) return;
    if (mesh.name === 'Wolf3D_Head') headGeo = mesh.geometry;
  });
  if (!headGeo) throw new Error('[faceRig] Wolf3D_Head not found in the GLB');

  // NOTE: RPM exports skinned meshes whose vertex data is already in the
  // bind/world pose, with an identity node transform. The previous build
  // multiplied by `matrixWorld`, which is meaningless for a SkinnedMesh and
  // is a large part of why the geometry drifted. We read positions as-is.
  const geo = headGeo as THREE.BufferGeometry;

  // GLTFLoader may hand back INTERLEAVED attributes — the RPM export packs
  // pos/normal/uv/joints/weights into one 13-float stride. Reading `.array`
  // linearly as packed vec3s then reads normals as positions and the whole
  // cloud degenerates (0 dots). Extract via getX/getY/getZ, which is correct
  // for both regular and interleaved attributes.
  const extractVec3 = (attr: THREE.BufferAttribute | THREE.InterleavedBufferAttribute): Float32Array => {
    const out = new Float32Array(attr.count * 3);
    for (let i = 0; i < attr.count; i++) {
      out[i * 3] = attr.getX(i);
      out[i * 3 + 1] = attr.getY(i);
      out[i * 3 + 2] = attr.getZ(i);
    }
    return out;
  };

  const pos = extractVec3(geo.attributes.position);
  const nor = geo.attributes.normal ? extractVec3(geo.attributes.normal) : null;
  const index = geo.index ? (geo.index.array as ArrayLike<number>) : null;

  const morphs = geo.morphAttributes?.position ?? [];
  const names: string[] = (geo.userData?.targetNames as string[])
    ?? ((geo as unknown as { morphTargetsRelative?: boolean }) && ['mouthOpen', 'mouthSmile']);
  const findMorph = (want: string): Float32Array | null => {
    const i = names.findIndex((n) => n === want);
    if (i >= 0 && morphs[i]) return extractVec3(morphs[i] as THREE.BufferAttribute);
    return null;
  };
  const morphOpen = findMorph('mouthOpen');
  const morphSmile = findMorph('mouthSmile');

  const pts = sampleSurface(pos, nor, morphOpen, morphSmile, index, faceDots, rng);

  // Drop the neck, and drop interior geometry.
  //
  // The RPM head is a closed mesh: the lips wrap inward into a mouth bag and
  // the sockets continue behind the eyes. Those surfaces sample happily and
  // then show straight through the face as a bright clump on the chin,
  // because additive points have no occlusion of their own. A surface whose
  // normal points back toward the head centre is by definition interior.
  const hc = { x: 0, y: 1.7050, z: 0.0250 };
  const kept = pts.filter((p) => {
    if (p.y < jawlineY(p.z) - JAW_FADE - 0.004) return false;
    const rx = p.x - hc.x, ry = p.y - hc.y, rz = p.z - hc.z;
    const rl = Math.hypot(rx, ry, rz) || 1;
    const outward = (p.nx * rx + p.ny * ry + p.nz * rz) / rl;
    if (outward < -0.20) return false;
    // The mouth bag runs behind the lips. The cut sits at z = 0.092, which is
    // comfortably behind the lip corners at 0.105 — an earlier, shallower cut
    // took the corners with it and left a hole where the mouth should be.
    const inMouth = field(p.x, p.y, p.z, L.mouthCenter, 0.062, 0.034, 0.078) > 0.02;
    if (inMouth && p.z < 0.092) return false;
    return true;
  });

  const aus = buildActionUnits(kept);
  const eyes = buildEyes(rng, eyeDots);

  // ── Normalise: centre the head and scale it to sit inside the frame ──
  // Measured off the surviving dots rather than off constants, so changing
  // the crop can never silently push the head out of frame again. At 34° FOV
  // and a 3.15 camera distance the visible height is ~1.93 units; 1.40 leaves
  // room for the idle rotation and the glow.
  let bMinY = Infinity, bMaxY = -Infinity;
  let bMinZ = Infinity, bMaxZ = -Infinity;
  for (const q of kept) {
    if (q.y < bMinY) bMinY = q.y;
    if (q.y > bMaxY) bMaxY = q.y;
    if (q.z < bMinZ) bMinZ = q.z;
    if (q.z > bMaxZ) bMaxZ = q.z;
  }
  const cx = 0;
  const cy = (bMinY + bMaxY) / 2;
  const cz = (bMinZ + bMaxZ) / 2;
  const scale = 1.40 / Math.max(1e-6, bMaxY - bMinY);

  const n = kept.length;
  const base = new Float32Array(n * 3);
  const normal = new Float32Array(n * 3);
  const seed = new Float32Array(n);
  const alpha = new Float32Array(n);
  const feature = new Float32Array(n);

  for (let i = 0; i < n; i++) {
    const p = kept[i];
    const o = i * 3;
    base[o] = (p.x - cx) * scale;
    base[o + 1] = (p.y - cy) * scale;
    base[o + 2] = (p.z - cz) * scale;
    normal[o] = p.nx; normal[o + 1] = p.ny; normal[o + 2] = p.nz;
    seed[i] = rng();
    // The dissolve at the jawline — the head fades out rather than being cut.
    const cut = jawlineY(p.z);
    alpha[i] = smoothstep(cut - JAW_FADE, cut + 0.008, p.y);
    feature[i] = importanceAt(p.x, p.y, p.z);
  }

  // Scale every AU delta into the same normalised space.
  for (const name of AU_NAMES) {
    const d = aus[name].delta;
    for (let i = 0; i < d.length; i++) d[i] *= scale;
  }

  const tf = (a: V3 | readonly number[]): [number, number, number] => {
    const p = Array.isArray(a) ? a : [(a as V3).x, (a as V3).y, (a as V3).z];
    return [(p[0] - cx) * scale, (p[1] - cy) * scale, (p[2] - cz) * scale];
  };

  const eb = eyes.base;
  for (let i = 0; i < eb.length; i += 3) {
    eb[i] = (eb[i] - cx) * scale;
    eb[i + 1] = (eb[i + 1] - cy) * scale;
    eb[i + 2] = (eb[i + 2] - cz) * scale;
  }

  return {
    base, normal, seed, alpha, feature, count: n,
    aus,
    eye: {
      ...eyes,
      centerL: tf(L.eyeL),
      centerR: tf(L.eyeR),
      radius: L.eyeRadius * scale,
    },
    xf: {
      center: [cx, cy, cz],
      scale,
      lm: {
        eyeL: tf(L.eyeL), eyeR: tf(L.eyeR),
        mouthCenter: tf(L.mouthCenter),
        noseTip: tf(L.noseTip),
        chin: tf(L.chin),
        jawHinge: tf(L.jawHinge),
        browL: tf(L.browL), browR: tf(L.browR),
      },
    },
  };
}
