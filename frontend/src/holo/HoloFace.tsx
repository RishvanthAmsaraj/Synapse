import { useEffect, useRef, type MutableRefObject } from 'react';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

/**
 * HoloFace v3 — a Gideon/Jarvis-style holographic face.
 *
 * Loads a Ready Player Me head (head.glb), bakes the world transforms, then
 * RE-SAMPLES the mesh surface into a dense, even dot-matrix (thousands of
 * points instead of the raw sparse vertices). Regions are tagged by position
 * so the mouth is animated procedurally:
 *   - jaw points (lower face) drop + push forward with TTS audio (lip sync)
 *   - eye points fade on a blink cycle
 *   - the whole head floats and turns in 3D
 *
 * Lip sync is amplitude-driven (Gemini Live exposes no visemes), so the jaw
 * follows speech volume rather than exact phonemes.
 */

interface HoloFaceProps {
  status: string;
  listening: boolean;
  mini?: boolean;
  micPeakRef: MutableRefObject<number>;
  ttsPeakRef: MutableRefObject<number>;
}

const HEAD_MESH_RE = /^(Wolf3D_Head|EyeLeft|EyeRight|Wolf3D_Teeth)$/;
const HOLO_COLOR = 0x59ddff;

type Region = 'jaw' | 'rest';

function regionOf(x: number, y: number): Region {
  return y < 1.665 ? 'jaw' : 'rest';
}

/** Sample `count` points uniformly across the mesh surface (area-weighted). */
function sampleSurface(
  pos: Float32Array,
  index: { array: Uint16Array | Uint32Array } | null,
  count: number,
): [number, number, number][] {
  const tris: [number, number, number][] = [];
  if (index) {
    for (let i = 0; i < index.array.length; i += 3) {
      tris.push([index.array[i] * 3, index.array[i + 1] * 3, index.array[i + 2] * 3]);
    }
  } else {
    const vc = pos.length / 3;
    for (let i = 0; i + 2 < vc; i += 3) tris.push([i * 3, (i + 1) * 3, (i + 2) * 3]);
  }

  // area-weighted triangle pick
  const area = (t: [number, number, number]) => {
    const ai = t[0], bi = t[1], ci = t[2];
    const ax = pos[ai], ay = pos[ai + 1], az = pos[ai + 2];
    const bx = pos[bi], by = pos[bi + 1], bz = pos[bi + 2];
    const cx = pos[ci], cy = pos[ci + 1], cz = pos[ci + 2];
    const ux = bx - ax, uy = by - ay, uz = bz - az;
    const wx = cx - ax, wy = cy - ay, wz = cz - az;
    const nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
    return 0.5 * Math.hypot(nx, ny, nz);
  };
  const areas = tris.map(area);
  const total = areas.reduce((s, a) => s + a, 0);

  const out: [number, number, number][] = [];
  for (let k = 0; k < count; k++) {
    let r = Math.random() * total;
    let ti = 0;
    if (total <= 0) {
      ti = Math.floor(Math.random() * tris.length);
    } else {
      for (let i = 0; i < areas.length; i++) { r -= areas[i]; if (r <= 0) { ti = i; break; } }
    }
    const t = tris[ti];
    const x0 = pos[t[0]], y0 = pos[t[0] + 1], z0 = pos[t[0] + 2];
    const x1 = pos[t[1]], y1 = pos[t[1] + 1], z1 = pos[t[1] + 2];
    const x2 = pos[t[2]], y2 = pos[t[2] + 1], z2 = pos[t[2] + 2];
    let u = Math.random(), v = Math.random();
    if (u + v > 1) { u = 1 - u; v = 1 - v; }
    out.push([
      x0 + u * (x1 - x0) + v * (x2 - x0),
      y0 + u * (y1 - y0) + v * (y2 - y0),
      z0 + u * (z1 - z0) + v * (z2 - z0),
    ]);
  }
  return out;
}

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

    let faceGeo: THREE.BufferGeometry | null = null;
    let faceBase: Float32Array | null = null;
    let faceRegions: Region[] = [];
    let eyeGeo: THREE.BufferGeometry | null = null;
    let eyeBase: Float32Array | null = null;
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
        const facePts: [number, number, number][] = [];
        const eyePts: [number, number, number][] = [];
        const faceReg: Region[] = [];

        gltf.scene.traverse((obj) => {
          const mesh = obj as THREE.Mesh;
          if (!mesh.isMesh) return;
          if (!HEAD_MESH_RE.test(mesh.name)) return;
          const geom = mesh.geometry.clone();
          geom.applyMatrix4(mesh.matrixWorld); // bake to world space
          const pos = geom.attributes.position.array as Float32Array;
          const isEye = mesh.name.startsWith('Eye');
          const n = isEye ? 120 : mesh.name === 'Wolf3D_Head' ? 3600 : 220;
          const samples = sampleSurface(pos, geom.index as { array: Uint16Array | Uint32Array } | null, n);
          for (const p of samples) {
            if (isEye) eyePts.push(p);
            else { facePts.push(p); faceReg.push(regionOf(p[0], p[1])); }
          }
        });

        // Center + scale the merged point cloud (head ~0.31 world units tall).
        const all = facePts.concat(eyePts);
        let minX = Infinity, minY = Infinity, minZ = Infinity;
        let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
        for (const p of all) {
          if (p[0] < minX) minX = p[0]; if (p[0] > maxX) maxX = p[0];
          if (p[1] < minY) minY = p[1]; if (p[1] > maxY) maxY = p[1];
          if (p[2] < minZ) minZ = p[2]; if (p[2] > maxZ) maxZ = p[2];
        }
        const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2, cz = (minZ + maxZ) / 2;
        const maxDim = Math.max(maxX - minX, maxY - minY, maxZ - minZ);
        const s = 2.0 / maxDim;
        const tf = (p: [number, number, number]) => [(p[0] - cx) * s, (p[1] - cy) * s, (p[2] - cz) * s];

        const faceT = facePts.map(tf);
        const eyeT = eyePts.map(tf);

        faceRegions = faceReg.slice();
        faceBase = new Float32Array(faceT.flat());
        faceGeo = new THREE.BufferGeometry();
        faceGeo.setAttribute('position', new THREE.BufferAttribute(faceBase.slice(), 3));

        eyeBase = new Float32Array(eyeT.flat());
        eyeGeo = new THREE.BufferGeometry();
        eyeGeo.setAttribute('position', new THREE.BufferAttribute(eyeBase.slice(), 3));

        const faceMat = new THREE.PointsMaterial({
          color: HOLO_COLOR, size: 0.016, sizeAttenuation: true, transparent: true,
          opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false,
        });
        const eyeMat = new THREE.PointsMaterial({
          color: HOLO_COLOR, size: 0.02, sizeAttenuation: true, transparent: true,
          opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false,
        });
        headGroup.add(new THREE.Points(faceGeo, faceMat));
        headGroup.add(new THREE.Points(eyeGeo, eyeMat));

        loaded = true;
        console.log('[holoface] v3 loaded', facePts.length, 'face pts,', eyePts.length, 'eye pts');
      },
      undefined,
      (err) => console.error('[holoface] load error:', err),
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
      const baseOpacity = disconnected ? 0.4 : 1;
      const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

      headGroup.rotation.y = reduced ? 0 : Math.sin(time * 0.35) * 0.45;
      headGroup.position.y = reduced ? 0 : Math.sin(time * 0.9) * 0.05;

      if (loaded && faceGeo && faceBase) {
        // Jaw drop: jaw region moves DOWN + slightly FORWARD with speech.
        const jawDrop = mouthOpen * 0.16;
        const jawFwd = mouthOpen * 0.05;
        const arr = (faceGeo.getAttribute('position') as THREE.BufferAttribute).array as Float32Array;
        for (let i = 0; i < faceRegions.length; i++) {
          const o = i * 3;
          if (faceRegions[i] === 'jaw') {
            arr[o] = faceBase[o];
            arr[o + 1] = faceBase[o + 1] - jawDrop;
            arr[o + 2] = faceBase[o + 2] + jawFwd;
          } else {
            arr[o] = faceBase[o];
            arr[o + 1] = faceBase[o + 1];
            arr[o + 2] = faceBase[o + 2];
          }
        }
        (faceGeo.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
      }
      if (loaded && eyeGeo && eyeBase) {
        const eyeMat = (headGroup.children[1] as THREE.Points).material as THREE.PointsMaterial;
        eyeMat.opacity = (0.95 * baseOpacity) * (0.1 + 0.9 * (1 - blinking));
      }

      renderer.render(scene, camera);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

    const onResize = () => {
      const s2 = container.clientWidth || 220;
      renderer.setSize(s2, s2);
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
