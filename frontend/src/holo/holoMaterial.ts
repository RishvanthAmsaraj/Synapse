import * as THREE from 'three';

/**
 * holoMaterial.ts — the look.
 *
 * The single most important thing in here is the facing term. A point cloud
 * rendered additively with depth-write off shows you the back of the skull
 * straight through the front of the face, and the result is a glowing blob
 * that never resolves into features. Dimming dots by how far their normal
 * turns away from the camera restores the silhouette and the sense of
 * volume — it is the difference between a sphere of sparks and a face.
 *
 * On top of that: soft sprites rather than squares, aerial-perspective
 * tinting with depth, a slow scanline, per-dot instability, and a
 * materialise parameter that lets the whole head assemble out of a cloud.
 */

export interface HoloUniforms {
  uTime: { value: number };
  uSize: { value: number };
  uPixelRatio: { value: number };
  uOpacity: { value: number };
  uCore: { value: THREE.Color };
  uMid: { value: THREE.Color };
  uDeep: { value: THREE.Color };
  /** 0 = fully scattered cloud, 1 = assembled face. */
  uMaterialize: { value: number };
  /** Scanline position in local Y, plus its strength. */
  uScanY: { value: number };
  uScanGain: { value: number };
  /** Rises while speaking — brightens and destabilises the dots. */
  uEnergy: { value: number };
  /** Momentary interference, used on interrupts and state changes. */
  uGlitch: { value: number };
  /** How hard back-facing dots are suppressed. 1 = full occlusion feel. */
  uOcclusion: { value: number };
  /** 1 = shaded by the key light, 0 = self-luminous (the eyes). */
  uLit: { value: number };
}

const VERT = /* glsl */ `
  attribute vec3 aNormal;
  attribute float aSeed;
  attribute float aAlpha;
  attribute float aFeature;

  uniform float uTime;
  uniform float uSize;
  uniform float uPixelRatio;
  uniform float uMaterialize;
  uniform float uScanY;
  uniform float uScanGain;
  uniform float uEnergy;
  uniform float uGlitch;
  uniform float uOcclusion;
  uniform float uLit;

  varying float vBright;
  varying float vFacing;
  varying float vSeed;
  varying float vDepth;
  varying float vScan;

  // Cheap hash for per-dot variation.
  float h1(float n) { return fract(sin(n * 127.1) * 43758.5453); }

  void main() {
    vSeed = aSeed;

    vec3 p = position;

    // Materialise: dots start pushed out along their own normal, scattered,
    // and converge onto the surface. Because the offset follows the normal
    // the cloud always reads as a shell of the head rather than a puff.
    float m = clamp(uMaterialize, 0.0, 1.0);
    if (m < 0.999) {
      float scatter = (1.0 - m);
      float jitter = h1(aSeed * 311.7) * 2.0 - 1.0;
      p += aNormal * scatter * (0.30 + 0.55 * h1(aSeed * 71.3));
      p += vec3(jitter, h1(aSeed * 913.1) * 2.0 - 1.0, h1(aSeed * 57.9) * 2.0 - 1.0)
           * scatter * 0.16;
    }

    // Interference: a brief lateral tear, strongest on a horizontal band.
    if (uGlitch > 0.001) {
      float band = step(0.62, fract(p.y * 3.1 + uTime * 5.0));
      p.x += band * uGlitch * (h1(aSeed * 17.3) - 0.5) * 0.28;
    }

    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    vec3 viewNormal = normalize(normalMatrix * aNormal);
    vec3 toCam = normalize(-mv.xyz);

    // The facing term. Front-facing dots are full strength; dots pointing
    // away fall to a floor value so the far side of the head only ghosts
    // through, exactly like a real volumetric projection.
    float raw = dot(viewNormal, toCam);
    vFacing = raw;
    float front = smoothstep(-0.35, 0.55, raw);
    float occl = mix(1.0, mix(0.045, 1.0, front), uOcclusion);

    // Shading. Camera-facing alone produces a flat oval mask — every dot on
    // the front of the head is equally lit, so the nose, brow ridge and lips
    // vanish. A directional key restores the form: the shading gradient IS
    // the face. Both lights live in view space, so turning the head sweeps
    // the highlight across it and the volume reads in motion too.
    vec3 KEY  = normalize(vec3(-0.42, 0.50, 0.76));
    vec3 FILL = normalize(vec3( 0.66, -0.10, 0.44));
    float key  = max(0.0, dot(viewNormal, KEY));
    float fill = max(0.0, dot(viewNormal, FILL)) * 0.30;
    // Ambient floor keeps the unlit side populated — this is a projection,
    // not an opaque object, so nothing should go fully black.
    // Eyes opt out (uLit = 0): running the key over them leaves one eye
    // dimmer than the other, which reads as damage rather than as lighting.
    float shade = mix(1.0, 0.19 + 1.02 * (key + fill), uLit);

    // Rim: dots at grazing angles sit on the silhouette and get a lift,
    // which is what gives the head its glowing outline.
    float rim = pow(1.0 - abs(raw), 3.0) * 0.85;

    // Scanline sweep, in local space so it tracks the head as it turns.
    float scan = exp(-pow((position.y - uScanY) * 6.5, 2.0)) * uScanGain;
    vScan = scan;

    // Per-dot flicker — slow, low amplitude, uncorrelated between dots.
    float flick = 0.86 + 0.14 * sin(uTime * (1.6 + aSeed * 3.4) + aSeed * 42.0);

    float feature = 0.72 + 0.55 * aFeature;

    vBright = occl * shade * flick * feature * aAlpha * (1.0 + rim + scan * 1.4)
              * (0.86 + 0.30 * uEnergy)
              * mix(0.35, 1.0, m);

    vDepth = clamp((-mv.z - 2.0) / 2.6, 0.0, 1.0);

    gl_Position = projectionMatrix * mv;

    // Size tracks facing and feature weight, with perspective attenuation.
    // Lit dots also grow slightly. Size and brightness reinforcing each
    // other is what gives the dot field an apparent surface.
    float size = uSize
      * (0.62 + 0.55 * front)
      * (0.68 + 0.46 * shade)
      * (0.74 + 0.52 * aSeed)
      * (0.86 + 0.40 * aFeature)
      * (1.0 + scan * 0.9);
    gl_PointSize = size * uPixelRatio * (1.0 / max(0.35, -mv.z));
  }
`;

const FRAG = /* glsl */ `
  precision highp float;

  uniform vec3 uCore;
  uniform vec3 uMid;
  uniform vec3 uDeep;
  uniform float uOpacity;
  uniform float uEnergy;

  varying float vBright;
  varying float vFacing;
  varying float vSeed;
  varying float vDepth;
  varying float vScan;

  void main() {
    // Soft round sprite with a hot centre — a hard square point is the
    // fastest way to make a point cloud look like debug output.
    vec2 uv = gl_PointCoord - 0.5;
    float d = length(uv);
    if (d > 0.5) discard;

    float halo = smoothstep(0.5, 0.06, d);
    float core = smoothstep(0.22, 0.0, d);
    float a = halo * 0.55 + core * 0.85;

    // Aerial perspective: dots further into the head cool off and desaturate,
    // which reads as atmospheric depth inside the projection volume.
    vec3 col = mix(uMid, uDeep, vDepth);
    col = mix(col, uCore, core * 0.75 + vScan * 0.5);
    col = mix(col, uCore, clamp(uEnergy * 0.35, 0.0, 0.5) * core);

    // Silhouette dots pick up a touch more saturation.
    col = mix(col, uMid, pow(1.0 - abs(vFacing), 2.0) * 0.35);

    float alpha = a * vBright * uOpacity * (0.85 + 0.15 * vSeed);
    if (alpha < 0.004) discard;

    gl_FragColor = vec4(col * (0.55 + 0.75 * vBright), alpha);
  }
`;

export function createHoloMaterial(opts: {
  core: string; mid: string; deep: string; size: number; pixelRatio: number;
}): THREE.ShaderMaterial & { uniforms: HoloUniforms } {
  const uniforms: HoloUniforms = {
    uTime: { value: 0 },
    uSize: { value: opts.size },
    uPixelRatio: { value: opts.pixelRatio },
    uOpacity: { value: 1 },
    uCore: { value: new THREE.Color(opts.core) },
    uMid: { value: new THREE.Color(opts.mid) },
    uDeep: { value: new THREE.Color(opts.deep) },
    uMaterialize: { value: 0 },
    uScanY: { value: -2 },
    uScanGain: { value: 0 },
    uEnergy: { value: 0 },
    uGlitch: { value: 0 },
    uOcclusion: { value: 1 },
    uLit: { value: 1 },
  };

  const mat = new THREE.ShaderMaterial({
    uniforms: uniforms as unknown as Record<string, THREE.IUniform>,
    vertexShader: VERT,
    fragmentShader: FRAG,
    transparent: true,
    depthWrite: false,
    depthTest: false,
    blending: THREE.AdditiveBlending,
  });

  return mat as THREE.ShaderMaterial & { uniforms: HoloUniforms };
}

/**
 * Eyes use the same lighting model but band the colour by iris / pupil so
 * the gaze direction stays readable at very small dot counts.
 */
const EYE_FRAG = /* glsl */ `
  precision highp float;

  uniform vec3 uCore;
  uniform vec3 uMid;
  uniform vec3 uDeep;
  uniform float uOpacity;
  uniform float uEnergy;

  varying float vBright;
  varying float vFacing;
  varying float vSeed;
  varying float vDepth;
  varying float vScan;
  varying float vPart;

  void main() {
    vec2 uv = gl_PointCoord - 0.5;
    float d = length(uv);
    if (d > 0.5) discard;

    float halo = smoothstep(0.5, 0.05, d);
    float core = smoothstep(0.26, 0.0, d);
    float a = halo * 0.5 + core * 0.95;

    // vPart: 0 sclera, 1 iris, 2 pupil. The pupil goes dark so the eye has a
    // real focal point instead of a uniform glowing disc.
    vec3 col = uMid;
    float gain = 1.0;
    // Banding, brightest first: catchlight, iris ring, then a barely-there
    // sclera. The pupil carries no dots at all — additive blending can only
    // add light, so a dark centre has to be an absence.
    if (vPart > 1.5)       { col = uCore;  gain = 1.15; }  // catchlight
    else if (vPart > 0.5)  { col = uCore;  gain = 0.52; }  // iris ring
    else                   { col = uMid;   gain = 0.10; }  // sclera

    float alpha = a * vBright * uOpacity * gain * (0.88 + 0.12 * vSeed);
    if (alpha < 0.004) discard;
    gl_FragColor = vec4(col * (0.6 + 0.8 * vBright), alpha);
  }
`;

const EYE_VERT = VERT
  .replace('attribute float aFeature;', 'attribute float aFeature;\n  attribute float aPart;')
  .replace('varying float vScan;', 'varying float vScan;\n  varying float vPart;')
  .replace('vSeed = aSeed;', 'vSeed = aSeed;\n    vPart = aPart;')
  // Eyes are self-luminous — running the key light over them makes one eye
  // dimmer than the other, which reads as damage rather than as lighting.
  .replace('float shade = 0.19 + 1.02 * (key + fill);', 'float shade = 1.0;');

export function createEyeMaterial(opts: {
  core: string; mid: string; deep: string; size: number; pixelRatio: number;
}): THREE.ShaderMaterial & { uniforms: HoloUniforms } {
  const uniforms: HoloUniforms = {
    uTime: { value: 0 },
    uSize: { value: opts.size },
    uPixelRatio: { value: opts.pixelRatio },
    uOpacity: { value: 1 },
    uCore: { value: new THREE.Color(opts.core) },
    uMid: { value: new THREE.Color(opts.mid) },
    uDeep: { value: new THREE.Color(opts.deep) },
    uMaterialize: { value: 0 },
    uScanY: { value: -2 },
    uScanGain: { value: 0 },
    uEnergy: { value: 0 },
    uGlitch: { value: 0 },
    // Near-full occlusion: without it the far eye shines straight through the
    // skull on a three-quarter turn.
    uOcclusion: { value: 0.88 },
    uLit: { value: 0 },
  };

  return new THREE.ShaderMaterial({
    uniforms: uniforms as unknown as Record<string, THREE.IUniform>,
    vertexShader: EYE_VERT,
    fragmentShader: EYE_FRAG,
    transparent: true,
    depthWrite: false,
    depthTest: false,
    blending: THREE.AdditiveBlending,
  }) as THREE.ShaderMaterial & { uniforms: HoloUniforms };
}
