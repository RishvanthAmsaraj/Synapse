import { useEffect, useRef, type MutableRefObject } from 'react';

/**
 * HoloFace — a Gideon/Jarvis-style holographic face.
 *
 * A particle (dot-projector) face rendered on a 2D canvas:
 * - head + facial features built from a few hundred glowing particles
 * - mouth opens/closes in sync with the assistant's TTS audio (ttsPeakRef)
 * - blinks, subtle head sway/float, holographic scanlines + flicker
 * - attentive when the user is talking (micPeakRef), animated when speaking
 *
 * True phoneme lip-sync isn't possible without viseme data from the TTS
 * provider (Gemini Live doesn't expose it), so the mouth is amplitude-driven —
 * visually convincing, not phoneme-accurate.
 */

interface HoloFaceProps {
  status: string;          // 'disconnected' | 'connecting' | 'connected'
  listening: boolean;      // mic is hot
  mini?: boolean;
  micPeakRef: MutableRefObject<number>;
  ttsPeakRef: MutableRefObject<number>;
}

// Virtual coordinate space the face is defined in (200 x 240).
const VW = 200;
const VH = 240;
const HEAD_CX = 100;
const HEAD_CY = 118;
const HEAD_RX = 68;
const HEAD_RY = 86;
const EYE_Y = 112;
const MOUTH_CY = 156;

type PType = 'fill' | 'outline' | 'eye' | 'pupil' | 'brow' | 'nose';

interface Particle {
  x: number;
  y: number;
  anchorY: number; // eye center for blink scaling (== y otherwise)
  type: PType;
  phase: number;   // per-particle flicker phase
}

function buildParticles(): Particle[] {
  const pts: Particle[] = [];
  const push = (x: number, y: number, type: PType, anchorY?: number) => {
    pts.push({ x, y, anchorY: anchorY ?? y, type, phase: Math.random() * Math.PI * 2 });
  };

  // Head outline
  for (let i = 0; i < 140; i++) {
    const a = (i / 140) * Math.PI * 2;
    push(HEAD_CX + Math.cos(a) * HEAD_RX, HEAD_CY + Math.sin(a) * HEAD_RY, 'outline');
  }
  // Sparse interior fill (translucent holographic surface)
  for (let i = 0; i < 130; i++) {
    const a = Math.random() * Math.PI * 2;
    const r = Math.sqrt(Math.random()) * 0.88;
    push(HEAD_CX + Math.cos(a) * HEAD_RX * r, HEAD_CY + Math.sin(a) * HEAD_RY * r, 'fill');
  }
  // Eyes + pupils
  for (const cx of [66, 134]) {
    for (let i = 0; i < 42; i++) {
      const a = (i / 42) * Math.PI * 2;
      push(cx + Math.cos(a) * 13, EYE_Y + Math.sin(a) * 7.5, 'eye', EYE_Y);
    }
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * Math.PI * 2;
      push(cx + Math.cos(a) * 5, EYE_Y + Math.sin(a) * 5, 'pupil', EYE_Y);
    }
  }
  // Brows (gentle arcs)
  for (const [x0, x1] of [[52, 80], [120, 148]] as [number, number][]) {
    for (let i = 0; i < 30; i++) {
      const t = i / 29;
      const x = x0 + (x1 - x0) * t;
      const y = 97 - Math.sin(t * Math.PI) * 4;
      push(x, y, 'brow');
    }
  }
  // Nose (faint)
  for (let i = 0; i < 13; i++) {
    push(100 + (Math.random() - 0.5) * 4, 122 + i * 1.7, 'nose');
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
    let mouthOpen = 0;     // smoothed
    let excitement = 0;    // smoothed "energy" from sustained speech

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

      // Blink timer
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
      excitement += (((ttsPeak > 0.55 ? 1 : 0)) - excitement) * 0.06;

      const micPeak = micPeakRef.current;
      micPeakRef.current = 0;

      // Motion (suppressed for reduced-motion)
      const floatY = reduced ? 0 : Math.sin(time * 0.9) * 3;
      const sway = reduced ? 0 : Math.sin(time * 0.5) * 0.045;
      const breathe = 1 + Math.sin(time * 1.7) * 0.006;
      const disconnected = st === 'disconnected' || st === 'connecting';
      const baseAlpha = disconnected ? 0.4 : 1;
      const pulse = disconnected ? 0.6 + 0.4 * Math.sin(time * 3) : 1;

      const dpr = window.devicePixelRatio || 1;
      const size = canvas.width / dpr;
      const scale = size / VH;
      const ox = canvas.width / 2;
      const oy = canvas.height / 2;

      ctx.clearRect(0, 0, canvas.width, canvas.height);

      // Halo
      const halo = ctx.createRadialGradient(ox, oy, size * 0.08, ox, oy, size * 0.55);
      halo.addColorStop(0, `rgba(${C}, ${0.16 * baseAlpha * pulse})`);
      halo.addColorStop(1, `rgba(${C}, 0)`);
      ctx.fillStyle = halo;
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      ctx.globalCompositeOperation = 'lighter';

      const tx = (x: number, y: number) => {
        const fx = x - HEAD_CX;
        const fy = y - HEAD_CY;
        const rx = fx * Math.cos(sway) - fy * Math.sin(sway);
        const ry = fx * Math.sin(sway) + fy * Math.cos(sway);
        const s = scale * breathe;
        return { px: ox + rx * s, py: oy + (ry + floatY) * s };
      };

      const dot = (px: number, py: number, alpha: number, r: number) => {
        ctx.fillStyle = `rgba(${C}, ${alpha})`;
        ctx.fillRect(px - r / 2, py - r / 2, r, r);
      };

      const eyeWiden = (isListening ? 1.15 : 1) + excitement * 0.12;
      const blinkFactor = (1 - blinking) * eyeWiden;
      const browLift = excitement * 5;

      for (const p of particles) {
        if (reduced && p.type === 'fill') continue; // skip shimmer noise
        let py = p.y;
        let alpha = 0;
        let r = 0;
        switch (p.type) {
          case 'fill': {
            const flick = 0.5 + 0.5 * Math.sin(time * 2 + p.phase);
            alpha = (0.045 + 0.03 * flick) * baseAlpha;
            r = scale * 0.02;
            break;
          }
          case 'outline': {
            const flick = 0.6 + 0.4 * Math.sin(time * 2.2 + p.phase);
            alpha = (0.32 + 0.2 * flick) * baseAlpha;
            r = scale * 0.028;
            break;
          }
          case 'brow':
            py = p.y - browLift;
            alpha = 0.5 * baseAlpha;
            r = scale * 0.024;
            break;
          case 'nose':
            alpha = 0.2 * baseAlpha;
            r = scale * 0.018;
            break;
          case 'eye':
            py = p.anchorY + (p.y - p.anchorY) * blinkFactor;
            alpha = 0.72 * baseAlpha;
            r = scale * 0.026;
            break;
          case 'pupil':
            py = p.anchorY + (p.y - p.anchorY) * blinkFactor;
            alpha = 0.95 * baseAlpha;
            r = scale * 0.034;
            break;
        }
        if (alpha <= 0.001) continue;
        const { px, py: _py } = tx(p.x, py);
        dot(px, _py, alpha, r);
      }

      // Mouth — ellipse that opens with speech; slight smile when closed
      const mRX = 20;
      const mRY = 2 + mouthOpen * 13;
      const smileLift = (1 - mouthOpen) * 6;
      const mSteps = 56;
      for (let i = 0; i < mSteps; i++) {
        const a = (i / mSteps) * Math.PI * 2;
        const corner = Math.abs(Math.cos(a)); // 1 at sides, 0 at top/bottom
        const mx = HEAD_CX + Math.cos(a) * mRX;
        const my = MOUTH_CY + Math.sin(a) * mRY - smileLift * corner * corner;
        const { px, py } = tx(mx, my);
        dot(px, py, 0.9 * baseAlpha, scale * 0.03);
      }

      ctx.globalCompositeOperation = 'source-over';

      // Scanlines
      ctx.fillStyle = `rgba(${C}, ${0.035 * baseAlpha})`;
      const lineH = scale * 0.06;
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

  const side = mini ? '104px' : 'min(46vw, 300px)';
  return (
    <div style={{ width: side, height: side, position: 'relative' }}>
      <canvas ref={canvasRef} style={{ width: '100%', height: '100%', display: 'block' }} />
    </div>
  );
}
