import { useEffect, useRef, type MutableRefObject } from 'react';

/**
 * HoloFace — a Gideon/Jarvis-style holographic face, rendered as a 3D
 * dot-matrix point cloud.
 *
 * The head is modeled as a dome of particles in 3D (x, y, and a depth z that
 * bulges forward from the silhouette to the center). Each frame it rotates
 * slowly around the Y axis and is projected with perspective, so particles
 * nearer the viewer are bigger/brighter — a genuine 3D turn, not a flat card.
 *
 * The mouth is driven by the assistant's TTS amplitude (lip sync); blinks are
 * periodic; the face is attentive while the mic is live. True phoneme-level
 * lip sync isn't possible without viseme data from Gemini Live, so the mouth
 * is amplitude-driven (convincing, not phoneme-accurate).
 */

interface HoloFaceProps {
  status: string;          // 'disconnected' | 'connecting' | 'connected'
  listening: boolean;      // mic is hot
  mini?: boolean;
  micPeakRef: MutableRefObject<number>;
  ttsPeakRef: MutableRefObject<number>;
}

// Virtual space the head is defined in (200 x 240 x depth).
const HEAD_CX = 100;
const HEAD_CY = 118;
const HEAD_RX = 68;
const HEAD_RY = 86;
const HEAD_DEPTH = 30;   // max forward bulge at the head center
const HEAD_CZ = 10;      // depth of the rotation axis (face sits slightly forward)
const EYE_Y = 112;
const MOUTH_CY = 156;
const PERSPECTIVE = 420; // perspective distance (virtual units)

type PType = 'fill' | 'outline' | 'eye' | 'pupil' | 'brow' | 'nose';

interface Particle {
  x: number;
  y: number;
  z: number;      // depth (0 = silhouette, HEAD_DEPTH = center)
  anchorY: number; // eye center for blink scaling
  type: PType;
  phase: number;
}

/** Depth of the head surface at a given (x, y) — a dome, 0 at the rim. */
function bulge(x: number, y: number): number {
  const nx = (x - HEAD_CX) / HEAD_RX;
  const ny = (y - HEAD_CY) / HEAD_RY;
  const d2 = nx * nx + ny * ny;
  if (d2 >= 1) return 0;
  return HEAD_DEPTH * Math.sqrt(1 - d2);
}

function buildParticles(): Particle[] {
  const pts: Particle[] = [];
  const push = (x: number, y: number, z: number, type: PType, anchorY?: number) => {
    pts.push({ x, y, z, anchorY: anchorY ?? y, type, phase: Math.random() * Math.PI * 2 });
  };

  // Head outline (silhouette rim, z = 0)
  for (let i = 0; i < 150; i++) {
    const a = (i / 150) * Math.PI * 2;
    push(HEAD_CX + Math.cos(a) * HEAD_RX, HEAD_CY + Math.sin(a) * HEAD_RY, 0, 'outline');
  }
  // Interior fill — points distributed through the head volume (z < surface)
  for (let i = 0; i < 170; i++) {
    const a = Math.random() * Math.PI * 2;
    const r = Math.sqrt(Math.random()) * 0.88;
    const x = HEAD_CX + Math.cos(a) * HEAD_RX * r;
    const y = HEAD_CY + Math.sin(a) * HEAD_RY * r;
    push(x, y, bulge(x, y) * (0.25 + 0.75 * Math.random()), 'fill');
  }
  // Eyes + pupils (on the surface)
  for (const cx of [66, 134]) {
    for (let i = 0; i < 42; i++) {
      const a = (i / 42) * Math.PI * 2;
      const x = cx + Math.cos(a) * 13;
      const y = EYE_Y + Math.sin(a) * 7.5;
      push(x, y, bulge(x, y), 'eye', EYE_Y);
    }
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * Math.PI * 2;
      const x = cx + Math.cos(a) * 5;
      const y = EYE_Y + Math.sin(a) * 5;
      push(x, y, bulge(x, y) + 2, 'pupil', EYE_Y);
    }
  }
  // Brows (on the surface)
  for (const [x0, x1] of [[52, 80], [120, 148]] as [number, number][]) {
    for (let i = 0; i < 30; i++) {
      const t = i / 29;
      const x = x0 + (x1 - x0) * t;
      const y = 97 - Math.sin(t * Math.PI) * 4;
      push(x, y, bulge(x, y), 'brow');
    }
  }
  // Nose (slightly proud of the surface)
  for (let i = 0; i < 13; i++) {
    const y = 122 + i * 1.7;
    const x = 100 + (Math.random() - 0.5) * 4;
    push(x, y, bulge(x, y) + 3, 'nose');
  }
  return pts;
}

const C = '80, 220, 255'; // holographic cyan

export function HoloFace({ status, listening, mini = false, micPeakRef, ttsPeakRef }: HoloFaceProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const statusRef = useRef(status);
  const listeningRef = useRef(listening);

  useEffect(() => {
    statusRef.current = status;
    listeningRef.current = listening;
  }, [status, listening]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const particles = buildParticles();
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    let raf = 0;
    let last = performance.now();
    let time = 0;
    let blinkTimer = 2 + Math.random() * 2;
    let blinking = 0;      // 0..1, 1 = eyes closed
    let mouthOpen = 0;
    let excitement = 0;

    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      const size = canvas.clientWidth || 220;
      canvas.width = Math.max(1, Math.round(size * dpr));
      canvas.height = Math.max(1, Math.round(size * dpr));
    };
    resize();
    window.addEventListener('resize', resize);

    const tick = (now: number) => {
      const dt = Math.min((now - last) / 1000, 0.05);
      last = now;
      time += dt;

      const st = statusRef.current;
      const isListening = listeningRef.current;

      // Blink
      blinkTimer -= dt;
      if (blinkTimer <= 0) {
        blinking = 1;
        blinkTimer = 2.5 + Math.random() * 3.2;
      }
      blinking = Math.max(0, blinking - dt * 9);

      // Mouth from TTS amplitude
      const ttsPeak = ttsPeakRef.current;
      ttsPeakRef.current = 0;
      const targetOpen = Math.min(1, ttsPeak * 3.4);
      mouthOpen += (targetOpen - mouthOpen) * (targetOpen > mouthOpen ? 0.4 : 0.12);
      excitement += ((ttsPeak > 0.55 ? 1 : 0) - excitement) * 0.06;
      const micPeak = micPeakRef.current;
      micPeakRef.current = 0;

      const floatY = reduced ? 0 : Math.sin(time * 0.9) * 3;
      const rotY = reduced ? 0 : Math.sin(time * 0.42) * 0.34; // 3D Y-turn
      const breathe = 1 + Math.sin(time * 1.7) * 0.006;
      const disconnected = st === 'disconnected' || st === 'connecting';
      const baseAlpha = disconnected ? 0.45 : 1;
      const pulse = disconnected ? 0.6 + 0.4 * Math.sin(time * 3) : 1;

      const dpr = window.devicePixelRatio || 1;
      const size = canvas.width / dpr;
      const scale = size / (HEAD_CY + HEAD_RY + 40); // fit the head nicely
      const dotScale = size / 300;                   // particle size factor
      const ox = canvas.width / 2;
      const oy = canvas.height / 2;

      ctx.clearRect(0, 0, canvas.width, canvas.height);

      // Halo
      const halo = ctx.createRadialGradient(ox, oy, size * 0.06, ox, oy, size * 0.55);
      halo.addColorStop(0, `rgba(${C}, ${0.2 * baseAlpha * pulse})`);
      halo.addColorStop(1, `rgba(${C}, 0)`);
      ctx.fillStyle = halo;
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      ctx.globalCompositeOperation = 'lighter';

      const cosR = Math.cos(rotY);
      const sinR = Math.sin(rotY);

      // Project a 3D point (x, y, z) through Y-rotation + perspective.
      const project = (x: number, y: number, z: number) => {
        const fx = x - HEAD_CX;
        const fz = z - HEAD_CZ;
        const rx = fx * cosR + fz * sinR;
        const rz = -fx * sinR + fz * cosR;
        const persp = 1 / (1 - rz / PERSPECTIVE);
        const s = scale * breathe;
        return {
          px: ox + rx * s * persp,
          py: oy + (y - HEAD_CY + floatY) * s * persp,
          persp,
        };
      };

      const dot = (px: number, py: number, alpha: number, r: number) => {
        if (alpha <= 0.004) return;
        ctx.fillStyle = `rgba(${C}, ${alpha})`;
        ctx.fillRect(px - r / 2, py - r / 2, r, r);
      };

      const eyeWiden = (isListening ? 1.15 : 1) + excitement * 0.12;
      const blinkFactor = (1 - blinking) * eyeWiden;
      const browLift = excitement * 5;

      // Particle radius (px) per type, then scaled by canvas size + perspective.
      const RADIUS: Record<PType, number> = {
        fill: 1.7, outline: 2.7, eye: 3.1, pupil: 4.4, brow: 2.5, nose: 1.9,
      };
      const ALPHA: Record<PType, number> = {
        fill: 0.07, outline: 0.5, eye: 0.8, pupil: 1.0, brow: 0.55, nose: 0.28,
      };

      for (const p of particles) {
        let y = p.y;
        let alpha = ALPHA[p.type] * baseAlpha;
        let r = RADIUS[p.type] * dotScale;

        if (p.type === 'fill') {
          alpha *= 0.5 + 0.5 * Math.sin(time * 2 + p.phase); // shimmer
        } else if (p.type === 'outline') {
          alpha *= 0.72 + 0.28 * Math.sin(time * 2.2 + p.phase);
        } else if (p.type === 'eye' || p.type === 'pupil') {
          y = p.anchorY + (p.y - p.anchorY) * blinkFactor; // blink
        } else if (p.type === 'brow') {
          y = p.y - browLift;
        }

        const { px, py, persp } = project(p.x, y, p.z);
        r = Math.max(1, r * persp);
        alpha *= 0.8 + 0.35 * persp; // nearer = brighter
        dot(px, py, alpha, r);
      }

      // Mouth — ellipse that opens with speech; slight smile when closed.
      const mRX = 20;
      const mRY = 2 + mouthOpen * 13;
      const smileLift = (1 - mouthOpen) * 6;
      const mSteps = 60;
      const mouthZ = bulge(HEAD_CX, MOUTH_CY);
      for (let i = 0; i < mSteps; i++) {
        const a = (i / mSteps) * Math.PI * 2;
        const corner = Math.abs(Math.cos(a));
        const mx = HEAD_CX + Math.cos(a) * mRX;
        const my = MOUTH_CY + Math.sin(a) * mRY - smileLift * corner * corner;
        const { px, py, persp } = project(mx, my, mouthZ);
        const r = Math.max(1, 3.1 * dotScale * persp);
        dot(px, py, 0.95 * baseAlpha * (0.8 + 0.35 * persp), r);
      }

      ctx.globalCompositeOperation = 'source-over';

      // Scanlines
      ctx.fillStyle = `rgba(${C}, ${0.035 * baseAlpha})`;
      const lineH = Math.max(2, size * 0.02);
      for (let y = 0; y < canvas.height; y += lineH * 2) {
        ctx.fillRect(0, y, canvas.width, lineH * 0.4);
      }

      raf = requestAnimationFrame(tick);
    };

    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', resize);
    };
  }, []);

  const side = mini ? '104px' : 'min(46vw, 320px)';
  return (
    <div style={{ width: side, height: side, position: 'relative' }}>
      <canvas ref={canvasRef} style={{ width: '100%', height: '100%', display: 'block' }} />
    </div>
  );
}
