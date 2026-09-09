import { useEffect, useRef, type MutableRefObject } from 'react';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

/**
 * HoloFace — a Gideon/Jarvis-style holographic face: a real 3D head rendered
 * as a dot-matrix point cloud, with morph-target lip sync and expression.
 *
 * Loads a Ready Player Me head (head.glb) which carries ARKit morph targets
 * (mouthOpen, mouthSmile). Three.js Points doesn't apply morph targets, so we
 * blend them manually each frame (glTF morphs are vertex deltas) into the
 * point positions, then render. Blinks are procedural (the separate eyeball
 * meshes squash on a blink cycle). The head floats and turns slowly in 3D.
 *
 * Lip sync is amplitude-driven from the TTS audio (no viseme data from Gemini
 * Live), so the jaw opens with speech volume rather than exact phonemes.
 */

interface HoloFaceProps {
  status: string;          // 'disconnected' | 'connecting' | 'connected'
  listening: boolean;      // mic is hot
  mini?: boolean;
  micPeakRef: MutableRefObject<number>;
  ttsPeakRef: MutableRefObject<number>;
}

// Meshes that make up the face (skip beard, body, outfits).
const HEAD_MESH_RE = /^(Wolf3D_Head|EyeLeft|EyeRight|Wolf3D_Teeth)$/;

interface FacePart {
  name: string;
  points: THREE.Points;
  base: Float32Array;              // pristine base vertex positions
  deltas: Float32Array[];          // morph-target deltas, indexed by morphIndex
  morphIndex: Record<string, number>; // morph name -> delta array index
  isEye: boolean;
}

const HOLO_COLOR = 0x59ddff;

export function HoloFace({ status, listening, mini = false, micPeakRef, ttsPeakRef }: HoloFaceProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const statusRef = useRef(status);
  const listeningRef = useRef(listening);

  useEffect(() => {
    statusRef.current = status;
    listeningRef.current = listening;
  }, [status, listening]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
    renderer.setClearColor(0x000000, 0);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    const size = container.clientWidth || 220;
    renderer.setSize(size, size);
    container.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(38, 1, 0.01, 100);
    camera.position.set(0, 0.02, 3.4);
    camera.lookAt(0, 0, 0);

    const headGroup = new THREE.Group();
    scene.add(headGroup);

    const parts: FacePart[] = [];
    let loaded = false;
    let mouthOpen = 0;
    let excitement = 0;
    let blinkTimer = 2 + Math.random() * 2;
    let blinking = 0;
    let time = 0;
    let raf = 0;
    let last = performance.now();

    const loader = new GLTFLoader();
    loader.load(
      '/head.glb',
      (gltf) => {
        gltf.scene.updateMatrixWorld(true);
        gltf.scene.traverse((obj) => {
          const mesh = obj as THREE.Mesh;
          if (!(mesh as THREE.Mesh).isMesh) return;
          if (!HEAD_MESH_RE.test(mesh.name)) return;

          const geom = mesh.geometry.clone();
          const mat = new THREE.PointsMaterial({
            color: HOLO_COLOR,
            size: 0.034,
            sizeAttenuation: true,
            transparent: true,
            opacity: 0.95,
            blending: THREE.AdditiveBlending,
            depthWrite: false,
          });
          const points = new THREE.Points(geom, mat);
          // Preserve the mesh's world transform without baking (keeps morph
          // deltas in local space).
          const p = new THREE.Vector3();
          const q = new THREE.Quaternion();
          const s = new THREE.Vector3();
          mesh.matrixWorld.decompose(p, q, s);
          points.position.copy(p);
          points.quaternion.copy(q);
          points.scale.copy(s);
          headGroup.add(points);

          const base = (geom.attributes.position.array as Float32Array).slice();
          const deltas: Float32Array[] = [];
          if (geom.morphAttributes.position) {
            for (const m of geom.morphAttributes.position) {
              deltas.push((m.array as Float32Array).slice());
            }
          }
          const morphIndex: Record<string, number> = {};
          const dict = (mesh as THREE.Mesh).morphTargetDictionary;
          if (dict) for (const [name, idx] of Object.entries(dict)) morphIndex[name] = idx as number;

          parts.push({ name: mesh.name, points, base, deltas, morphIndex, isEye: mesh.name.startsWith('Eye') });
        });

        // Center + scale the head to fill the view nicely.
        const box = new THREE.Box3().setFromObject(headGroup);
        const center = box.getCenter(new THREE.Vector3());
        const maxDim = Math.max(...(box.getSize(new THREE.Vector3()).toArray()));
        for (const child of headGroup.children) child.position.sub(center);
        headGroup.scale.setScalar(2.0 / Math.max(maxDim, 0.0001));

        loaded = true;
        console.log('[holoface] loaded', parts.map((p) => `${p.name}(${p.base.length / 3}v ${Object.keys(p.morphIndex).join('/')})`).join(' '));
      },
      undefined,
      (err) => console.error('[holoface] failed to load head.glb:', err),
    );

    const tick = (now: number) => {
      const dt = Math.min((now - last) / 1000, 0.05);
      last = now;
      time += dt;

      const st = statusRef.current;
      const isListening = listeningRef.current;

      const ttsPeak = ttsPeakRef.current;
      ttsPeakRef.current = 0;
      const targetOpen = Math.min(1, ttsPeak * 3.2);
      mouthOpen += (targetOpen - mouthOpen) * (targetOpen > mouthOpen ? 0.4 : 0.12);
      excitement += ((ttsPeak > 0.55 ? 1 : 0) - excitement) * 0.06;
      micPeakRef.current = 0;

      blinkTimer -= dt;
      if (blinkTimer <= 0) {
        blinking = 1;
        blinkTimer = 2.5 + Math.random() * 3.2;
      }
      blinking = Math.max(0, blinking - dt * 9);

      const disconnected = st === 'disconnected' || st === 'connecting';
      const baseOpacity = disconnected ? 0.35 : 1;
      const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

      headGroup.rotation.y = reduced ? 0 : Math.sin(time * 0.42) * 0.32;
      headGroup.position.y = reduced ? 0 : Math.sin(time * 0.9) * 0.04;

      const smile = 0.14 + excitement * 0.28 + (isListening ? 0.05 : 0);
      const blinkFactor = (1 - blinking) * 1.0;

      if (loaded) {
        for (const part of parts) {
          const posArr = part.points.geometry.attributes.position.array as Float32Array;
          posArr.set(part.base);

          const wOpen = part.morphIndex.mouthOpen !== undefined ? Math.min(1, mouthOpen * 2.6) : 0;
          const wSmile = part.morphIndex.mouthSmile !== undefined ? smile : 0;
          if (wOpen !== 0 && part.deltas[part.morphIndex.mouthOpen]) {
            const d = part.deltas[part.morphIndex.mouthOpen];
            for (let i = 0; i < posArr.length; i++) posArr[i] += d[i] * wOpen;
          }
          if (wSmile !== 0 && part.deltas[part.morphIndex.mouthSmile]) {
            const d = part.deltas[part.morphIndex.mouthSmile];
            for (let i = 0; i < posArr.length; i++) posArr[i] += d[i] * wSmile;
          }
          part.points.geometry.attributes.position.needsUpdate = true;

          let opacity = 0.9 * baseOpacity;
          if (part.isEye) opacity *= 0.12 + 0.88 * blinkFactor; // blink via fade
          (part.points.material as THREE.PointsMaterial).opacity = opacity;
        }
      }

      renderer.render(scene, camera);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

    const onResize = () => {
      const s = container.clientWidth || 220;
      renderer.setSize(s, s);
    };
    window.addEventListener('resize', onResize);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', onResize);
      renderer.dispose();
      if (renderer.domElement.parentNode === container) container.removeChild(renderer.domElement);
    };
  }, []);

  const side = mini ? '104px' : 'min(46vw, 320px)';
  return (
    <div
      style={{
        width: side,
        height: side,
        position: 'relative',
        borderRadius: '50%',
        background: 'radial-gradient(circle at 50% 45%, rgba(89,221,255,0.14), rgba(89,221,255,0) 65%)',
      }}
    >
      <div ref={containerRef} style={{ position: 'absolute', inset: 0 }} />
    </div>
  );
}
