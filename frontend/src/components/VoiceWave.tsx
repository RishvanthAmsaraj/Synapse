import { useEffect, useRef, type MutableRefObject } from 'react';
import './VoiceWave.css';

/**
 * VoiceWave — the only connection indicator.
 *
 * There is no text label. State is carried entirely by colour: grey and
 * nearly still when there is no session, alive and shifting through blue,
 * violet and green when there is. That is a faster read than a word, and it
 * answers the question people actually have, which is not "what is the
 * connection state" but "is it hearing me right now".
 *
 * It responds to the MICROPHONE only, never to the agent's own voice. A wave
 * that moved while the agent spoke would tell you nothing about whether you
 * are getting through.
 */
export function VoiceWave({
  levelRef, active, connected,
}: {
  levelRef: MutableRefObject<number>;
  active: boolean;
  connected: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const state = useRef({ active, connected });
  state.current = { active, connected };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const W = 190, H = 34;
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    ctx.scale(dpr, dpr);

    let raf = 0;
    let t = 0;
    let amp = 0;
    let live = 0;   // eased 0→1 as the session comes up, drives colour
    let hue = 214;

    const draw = () => {
      raf = requestAnimationFrame(draw);
      t += reduced ? 0.004 : 0.038;

      const { active: isActive, connected: isLive } = state.current;
      const target = isActive ? Math.min(1, levelRef.current * 1.4) : 0;
      // Rise fast, fall slow — the worklet reports peaks, so this tracks
      // speech instead of flickering on every syllable boundary.
      amp += (target - amp) * (target > amp ? 0.42 : 0.07);
      live += ((isLive ? 1 : 0) - live) * 0.06;

      // Colour drifts continuously while connected: blue → violet → green,
      // riding faster and lightening toward white as your voice comes in.
      hue += (0.28 + amp * 1.5) * (reduced ? 0.15 : 1);
      if (hue > 360) hue -= 360;
      const band = 150 + 130 * (0.5 + 0.5 * Math.sin(hue * Math.PI / 180));
      const sat = 12 + live * (58 + amp * 30);
      const lum = 52 + live * (10 + amp * 34);
      const tint = (shift: number, a: number) =>
        `hsla(${(band + shift) % 360}, ${sat}%, ${Math.min(94, lum)}%, ${a})`;

      ctx.clearRect(0, 0, W, H);
      const mid = H / 2;

      // Horizontal gradient fading to nothing at both ends, so the wave sits
      // in space rather than being sliced off by the edge of the canvas.
      const grad = ctx.createLinearGradient(0, 0, W, 0);
      grad.addColorStop(0.00, tint(0, 0));
      grad.addColorStop(0.18, tint(-18, 0.85));
      grad.addColorStop(0.50, tint(0, 1));
      grad.addColorStop(0.82, tint(22, 0.85));
      grad.addColorStop(1.00, tint(40, 0));

      const bands = [
        { f: 1.0, s: 1.00, p: 0 },
        { f: 1.7, s: 0.55, p: 2.1 },
        { f: 2.6, s: 0.32, p: 4.3 },
      ];

      for (let layer = 0; layer < 2; layer++) {
        const scale = layer === 0 ? 1 : 0.5;
        ctx.beginPath();
        for (let x = 0; x <= W; x += 2) {
          const u = x / W;
          // Amplitude envelope tapers to zero at the ends as well, so the
          // line flattens into the fade instead of stopping mid-swing.
          const envelope = Math.sin(u * Math.PI) ** 1.3;
          let y = 0;
          for (const b of bands) {
            y += Math.sin(u * Math.PI * 2 * b.f * 2.2 + t * (1 + b.f * 0.5) + b.p) * b.s;
          }
          const rest = 0.07 + live * 0.06;
          ctx.lineTo(x, mid + y * (rest + amp * 0.95) * envelope * scale * (H * 0.44));
        }
        ctx.strokeStyle = grad;
        ctx.globalAlpha = layer === 0 ? 1 : 0.45;
        ctx.lineWidth = layer === 0 ? 2.1 : 1.3;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    };

    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [levelRef]);

  return (
    <canvas
      ref={canvasRef}
      className="voice-wave"
      style={{ width: 190, height: 34 }}
      role="img"
      aria-label={connected ? (active ? 'Listening' : 'Connected') : 'Not connected'}
    />
  );
}
