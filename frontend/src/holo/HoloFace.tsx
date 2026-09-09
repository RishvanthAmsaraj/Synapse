import { useEffect, useRef, type MutableRefObject } from 'react';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { buildFaceRig, AU_NAMES, type FaceRig } from './faceRig';
import { LipsyncAnalyser, VISEMES, VISEME_TO_AU, type VisemeFrame } from './lipsync';
import {
  AUAnimator, BlinkController, GazeController, Breath, EMOTIONS, fbm,
  type Emotion,
} from './expression';
import { createHoloMaterial, createEyeMaterial } from './holoMaterial';
import './HoloFace.css';

/**
 * HoloFace — the projected face.
 *
 * The component owns a single WebGL context for the life of the app. It is
 * never unmounted and never resized: the drawing buffer stays at a fixed
 * resolution and the element is moved and scaled with a CSS transform that
 * springs toward whichever anchor the layout is currently showing. That is
 * what lets the head travel between the hero and the session bar without
 * dropping a frame or losing its pose mid-turn — it is the same head, still
 * breathing, that simply moved.
 */

export type HoloLayout = 'hero' | 'docked';

interface HoloFaceProps {
  status: string;
  /** Microphone is open. */
  listening: boolean;
  /** Where the face should sit. */
  layout: HoloLayout;
  /** Element the face flies to. Rendered by the parent in either position. */
  anchorRef: MutableRefObject<HTMLElement | null>;
  /** Live output AnalyserNode — drives viseme-accurate lip sync. */
  analyserRef: MutableRefObject<AnalyserNode | null>;
  micPeakRef: MutableRefObject<number>;
  /** Overrides the automatically derived expression. */
  emotion?: Emotion;
  /** Bumped by the parent to fire the interference burst on barge-in. */
  interruptSignal?: number;
}

interface Spring { v: number; x: number }

function springTo(s: Spring, target: number, dt: number, stiffness = 120, damping = 20) {
  const a = stiffness * (target - s.x) - damping * s.v;
  s.v += a * dt;
  s.x += s.v * dt;
  return s.x;
}

/** Backing resolution is fixed so the layout move is a pure GPU transform. */
function pickQuality() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const mem = (navigator as unknown as { deviceMemory?: number }).deviceMemory ?? 8;
  const small = window.innerWidth < 720;
  if (small || mem <= 4) return { buffer: 460, faceDots: 4600, eyeDots: 54, dpr: Math.min(dpr, 1.75) };
  return { buffer: 620, faceDots: 7600, eyeDots: 72, dpr };
}

export function HoloFace({
  status, listening, layout, anchorRef, analyserRef, micPeakRef,
  emotion, interruptSignal = 0,
}: HoloFaceProps) {
  const hostRef = useRef<HTMLDivElement>(null);

  // Props read inside the animation loop, kept in a ref so the loop never
  // has to be torn down and rebuilt.
  const p = useRef({ status, listening, layout, emotion, interruptSignal });
  p.current = { status, listening, layout, emotion, interruptSignal };

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const q = pickQuality();
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    // ── Renderer ───────────────────────────────────────────────────
    const renderer = new THREE.WebGLRenderer({
      alpha: true, antialias: true, powerPreference: 'high-performance',
    });
    renderer.setClearColor(0x000000, 0);
    renderer.setPixelRatio(1); // buffer size is explicit; dpr is folded into uSize
    renderer.setSize(q.buffer, q.buffer, false);
    renderer.domElement.className = 'holo-canvas';
    host.style.width = `${q.buffer}px`;
    host.style.height = `${q.buffer}px`;
    host.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(34, 1, 0.1, 40);
    camera.position.set(0, 0, 3.15);

    const head = new THREE.Group();
    scene.add(head);

    // ── State ──────────────────────────────────────────────────────
    const anim = new AUAnimator();
    const blink = new BlinkController();
    const gaze = new GazeController();
    const breath = new Breath();
    const lip = new LipsyncAnalyser(1024, 24000);

    let rig: FaceRig | null = null;
    let faceGeo: THREE.BufferGeometry | null = null;
    let eyeGeo: THREE.BufferGeometry | null = null;
    let facePos: Float32Array | null = null;
    let eyePos: Float32Array | null = null;
    let eyeAlpha: Float32Array | null = null;
    let faceMat: ReturnType<typeof createHoloMaterial> | null = null;
    let eyeMat: ReturnType<typeof createEyeMaterial> | null = null;

    let time = 0;
    let raf = 0;
    let last = performance.now();
    let materialize = 0;
    let lastLayout: HoloLayout = p.current.layout;
    let lastInterrupt = p.current.interruptSignal;
    let glitch = 0;
    let scanY = -2;
    let scanActive = 0;
    let speechEnergy = 0;
    let listenGlow = 0;
    let frame: VisemeFrame | null = null;

    const layoutT: Spring = { x: p.current.layout === 'docked' ? 1 : 0, v: 0 };
    const rectSpring = {
      x: { x: 0, v: 0 } as Spring,
      y: { x: 0, v: 0 } as Spring,
      s: { x: 1, v: 0 } as Spring,
    };
    let placed = false;

    // ── Load and build ─────────────────────────────────────────────
    const loader = new GLTFLoader();
    loader.load('/head.glb', (gltf) => {
      const t0 = performance.now();
      rig = buildFaceRig(gltf.scene, { faceDots: q.faceDots, eyeDots: q.eyeDots });

      facePos = new Float32Array(rig.base);
      faceGeo = new THREE.BufferGeometry();
      faceGeo.setAttribute('position', new THREE.BufferAttribute(facePos, 3));
      faceGeo.setAttribute('aNormal', new THREE.BufferAttribute(rig.normal, 3));
      faceGeo.setAttribute('aSeed', new THREE.BufferAttribute(rig.seed, 1));
      faceGeo.setAttribute('aAlpha', new THREE.BufferAttribute(rig.alpha, 1));
      faceGeo.setAttribute('aFeature', new THREE.BufferAttribute(rig.feature, 1));

      eyePos = new Float32Array(rig.eye.base);
      eyeAlpha = new Float32Array(rig.eye.count).fill(1);
      eyeGeo = new THREE.BufferGeometry();
      eyeGeo.setAttribute('position', new THREE.BufferAttribute(eyePos, 3));
      eyeGeo.setAttribute('aNormal', new THREE.BufferAttribute(rig.eye.normal, 3));
      eyeGeo.setAttribute('aSeed', new THREE.BufferAttribute(rig.eye.seed, 1));
      eyeGeo.setAttribute('aAlpha', new THREE.BufferAttribute(eyeAlpha, 1));
      eyeGeo.setAttribute('aFeature', new THREE.BufferAttribute(new Float32Array(rig.eye.count).fill(1), 1));
      eyeGeo.setAttribute('aPart', new THREE.BufferAttribute(Float32Array.from(rig.eye.part), 1));

      const css = getComputedStyle(document.documentElement);
      const pick = (name: string, fallback: string) =>
        (css.getPropertyValue(name) || '').trim() || fallback;

      faceMat = createHoloMaterial({
        core: pick('--holo-core', '#eaf6ff'),
        mid: pick('--holo-mid', '#7fd8ff'),
        deep: pick('--holo-deep', '#3f6bd8'),
        size: 3.05 * q.dpr,
        pixelRatio: 1,
      });
      eyeMat = createEyeMaterial({
        core: pick('--holo-core', '#eaf6ff'),
        mid: pick('--holo-mid', '#7fd8ff'),
        deep: pick('--holo-deep', '#22407f'),
        size: 2.6 * q.dpr,
        pixelRatio: 1,
      });

      const facePoints = new THREE.Points(faceGeo, faceMat);
      const eyePoints = new THREE.Points(eyeGeo, eyeMat);
      facePoints.frustumCulled = false;
      eyePoints.frustumCulled = false;
      head.add(facePoints);
      head.add(eyePoints);

      // First appearance: assemble out of the cloud with a scan sweep.
      scanActive = 1;
      scanY = -1.4;
      console.info(
        `[holoface] rig built in ${(performance.now() - t0) | 0}ms — ` +
        `${rig.count} face dots, ${rig.eye.count} eye dots, ${AU_NAMES.length} action units`,
      );
    }, undefined, (err) => console.error('[holoface] failed to load head.glb', err));

    // ── Pointer gaze ───────────────────────────────────────────────
    let pointer: [number, number] | null = null;
    let pointerIdle = 0;
    const onPointerMove = (e: PointerEvent) => {
      pointer = [
        (e.clientX / window.innerWidth) * 2 - 1,
        -((e.clientY / window.innerHeight) * 2 - 1),
      ];
      pointerIdle = 0;
    };
    window.addEventListener('pointermove', onPointerMove, { passive: true });

    // ── Frame ──────────────────────────────────────────────────────
    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      const dt = Math.min((now - last) / 1000, 0.05);
      last = now;
      time += dt;

      const { status: st, listening: isListening, layout: lay } = p.current;
      const connected = st === 'connected';
      const dormant = st === 'disconnected';

      // ── Layout: measure the anchor, spring the element toward it ──
      const anchor = anchorRef.current;
      if (anchor) {
        const r = anchor.getBoundingClientRect();
        if (r.width > 0) {
          const targetS = r.width / q.buffer;
          const targetX = r.left + r.width / 2;
          const targetY = r.top + r.height / 2;
          if (!placed) {
            rectSpring.x.x = targetX; rectSpring.y.x = targetY; rectSpring.s.x = targetS;
            placed = true;
          }
          // Slightly under-damped so the head arrives with a little weight
          // rather than easing to a dead stop like a CSS transition.
          springTo(rectSpring.x, targetX, dt, 150, 23);
          springTo(rectSpring.y, targetY, dt, 150, 23);
          springTo(rectSpring.s, targetS, dt, 160, 24);
          host.style.transform =
            `translate3d(${rectSpring.x.x - q.buffer / 2}px, ${rectSpring.y.x - q.buffer / 2}px, 0)` +
            ` scale(${rectSpring.s.x})`;
        }
      }

      if (lay !== lastLayout) {
        lastLayout = lay;
        scanActive = 1;
        scanY = -1.4;
        glitch = 0.35;
        blink.trigger();
        gaze.look(lay === 'docked' ? 'canvas' : 'viewer');
      }
      springTo(layoutT, lay === 'docked' ? 1 : 0, dt, 90, 18);

      if (p.current.interruptSignal !== lastInterrupt) {
        lastInterrupt = p.current.interruptSignal;
        glitch = 0.55;
        blink.trigger();
        lip.reset();
      }
      glitch = Math.max(0, glitch - dt * 1.6);

      // ── Speech ────────────────────────────────────────────────────
      frame = lip.analyse(analyserRef.current, dt);
      const speaking = !frame.silent;
      speechEnergy += (frame.energy - speechEnergy) * (1 - Math.exp(-dt / 0.05));

      const micPeak = micPeakRef.current;
      micPeakRef.current = 0;
      listenGlow += ((isListening ? Math.max(0.25, micPeak) : 0) - listenGlow)
        * (1 - Math.exp(-dt / 0.12));

      // ── Expression ────────────────────────────────────────────────
      let mood: Emotion = p.current.emotion ?? 'neutral';
      if (!p.current.emotion) {
        if (dormant) mood = 'dormant';
        else if (st === 'connecting') mood = 'thinking';
        else if (speaking || isListening) mood = 'attentive';
        else if (connected) mood = 'neutral';
      }

      anim.clearTargets();
      anim.add(EMOTIONS[mood]);

      // Speech rides on top of the emotion. Visemes own the mouth; the
      // emotion keeps the brows and cheeks, so the face can smile while it
      // talks instead of switching between the two.
      if (speaking && frame) {
        for (const v of VISEMES) {
          const w = frame[v];
          if (w > 0.004) anim.add(VISEME_TO_AU[v], w);
        }
        // Prosody: loud syllables lift the brows slightly. This is automatic
        // in real speech, and its absence is much of why talking heads look
        // flat even when the mouth is correct.
        const accent = Math.max(0, speechEnergy - 0.35) * 0.55;
        anim.add({ browOuterUpL: accent, browOuterUpR: accent * 0.85 });
      } else if (isListening) {
        const d = (fbm(time * 0.35) * 0.5 + 0.5) * 0.12;
        anim.add({ browInnerUpL: d, browInnerUpR: d * 0.8 });
      }

      // Blink drives the lid AUs and the eyeball occlusion together.
      blink.rate = mood === 'thinking' ? 1.6 : speaking ? 1.15 : 1;
      blink.update(dt);
      anim.add({ squintL: blink.left * 1.05, squintR: blink.right * 1.05 });

      anim.update(dt);

      // ── Gaze ──────────────────────────────────────────────────────
      pointerIdle += dt;
      if (mood === 'thinking') gaze.look('away');
      else if (lay === 'docked' && speaking) gaze.look('canvas');
      else gaze.look('viewer');
      gaze.point = pointer && pointerIdle < 2.5 && lay === 'hero' ? pointer : null;
      gaze.update(dt);

      breath.update(dt, speechEnergy);

      // ── Apply the rig ─────────────────────────────────────────────
      if (rig && facePos && faceGeo) {
        facePos.set(rig.base);
        for (const name of AU_NAMES) {
          const w = anim.current[name];
          if (Math.abs(w) < 0.0025) continue;
          const { idx, delta } = rig.aus[name];
          for (let k = 0; k < idx.length; k++) {
            const o = idx[k] * 3;
            const d = k * 3;
            facePos[o] += delta[d] * w;
            facePos[o + 1] += delta[d + 1] * w;
            facePos[o + 2] += delta[d + 2] * w;
          }
        }
        (faceGeo.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
      }

      // ── Eyes: gaze rotation + lid occlusion ───────────────────────
      if (rig && eyePos && eyeGeo && eyeAlpha) {
        const gx = gaze.x, gy = gaze.y;
        const cy = Math.cos(gy), sy = Math.sin(gy);
        const cx = Math.cos(gx), sx = Math.sin(gx);
        const base = rig.eye.base;
        for (let i = 0; i < rig.eye.count; i++) {
          const o = i * 3;
          const c = rig.eye.side[i] === 0 ? rig.eye.centerL : rig.eye.centerR;
          const lx0 = base[o] - c[0], ly0 = base[o + 1] - c[1], lz0 = base[o + 2] - c[2];
          const y1 = ly0 * cy - lz0 * sy, z1 = ly0 * sy + lz0 * cy;
          const x2 = lx0 * cx + z1 * sx, z2 = -lx0 * sx + z1 * cx;
          eyePos[o] = c[0] + x2;
          eyePos[o + 1] = c[1] + y1;
          eyePos[o + 2] = c[2] + z2;

          // The lid is a hard horizontal edge sweeping down over the globe;
          // dots above it stop being drawn. Fading the whole eye instead
          // reads as the eye dimming, not as a blink.
          const b = rig.eye.side[i] === 0 ? blink.left : blink.right;
          const lidY = rig.eye.radius * (1 - 2.15 * b);
          eyeAlpha[i] = y1 < lidY ? 1 : 0;
        }
        (eyeGeo.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
        (eyeGeo.getAttribute('aAlpha') as THREE.BufferAttribute).needsUpdate = true;
      }

      // ── Head transform ────────────────────────────────────────────
      const dockBias = layoutT.x;
      if (reduced) {
        head.rotation.set(0, dockBias * -0.20, 0);
        head.position.set(0, 0, 0);
      } else {
        const idleY = fbm(time * 0.13) * 0.16;
        const idleX = fbm(time * 0.11 + 40) * 0.07;
        const idleZ = fbm(time * 0.09 + 80) * 0.05;
        head.rotation.y = idleY + gaze.headX + dockBias * -0.20;
        head.rotation.x = idleX - gaze.headY * 0.8;
        // Head tilt carries a lot of personality and costs nothing.
        head.rotation.z = idleZ + gaze.headX * 0.10;
        head.position.y = breath.offset + fbm(time * 0.21 + 12) * 0.012;
        head.position.x = fbm(time * 0.17 + 55) * 0.014;
        head.scale.setScalar(breath.scale);
      }

      // ── Uniforms ──────────────────────────────────────────────────
      materialize += ((rig ? 1 : 0) - materialize) * (1 - Math.exp(-dt / 0.55));

      if (scanActive > 0) {
        scanY += dt * 3.4;
        if (scanY > 1.5) { scanActive = 0; scanY = -2; }
      }

      const camZ = 3.15 + layoutT.x * 0.30;
      camera.position.z += (camZ - camera.position.z) * (1 - Math.exp(-dt / 0.25));
      const fov = 34 - layoutT.x * 3;
      if (Math.abs(camera.fov - fov) > 0.01) {
        camera.fov += (fov - camera.fov) * (1 - Math.exp(-dt / 0.3));
        camera.updateProjectionMatrix();
      }

      const energy = Math.max(speechEnergy, listenGlow * 0.6);
      const dim = dormant ? 0.42 : st === 'connecting' ? 0.72 : 1;

      for (const m of [faceMat, eyeMat]) {
        if (!m) continue;
        m.uniforms.uTime.value = time;
        m.uniforms.uMaterialize.value = materialize;
        m.uniforms.uEnergy.value = energy;
        m.uniforms.uGlitch.value = glitch;
        m.uniforms.uScanY.value = scanY;
        m.uniforms.uScanGain.value = scanActive * 0.9;
        m.uniforms.uOpacity.value = dim * (0.55 + 0.45 * materialize);
      }
      if (faceMat) {
        // Docked, the head is small on screen, so the dots need to be a
        // touch larger relative to it or the face stops resolving.
        faceMat.uniforms.uSize.value = (3.05 + layoutT.x * 0.9) * q.dpr;
      }

      renderer.render(scene, camera);
    };
    raf = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('pointermove', onPointerMove);
      faceGeo?.dispose();
      eyeGeo?.dispose();
      faceMat?.dispose();
      eyeMat?.dispose();
      renderer.dispose();
      if (renderer.domElement.parentNode === host) host.removeChild(renderer.domElement);
    };
    // Intentionally empty: the loop reads live values through refs so the
    // WebGL context survives every re-render and every layout change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="holo-layer" aria-hidden="true">
      <div ref={hostRef} className="holo-host" />
    </div>
  );
}
