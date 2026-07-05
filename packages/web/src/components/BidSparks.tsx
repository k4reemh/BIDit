import { useEffect, useRef } from 'react';

/**
 * A tiny additive-blend spark emitter that burns at the timer bar's leading edge
 * during the final seconds — like a lit fuse racing the clock. Ported from the
 * extension overlay. Only mount it while the auction is in its low-time state.
 */
export default function BidSparks({ fill, active }: { fill: number; active: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const fillRef = useRef(fill);
  const activeRef = useRef(active);
  fillRef.current = fill;
  activeRef.current = active;

  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    type P = { x: number; y: number; vx: number; vy: number; g: number; life: number; s: number; c: string };
    const parts: P[] = [];
    const COLORS = ['#ffffff', '#ffe27a', '#ffb020', '#ff7a45'];
    let raf = 0;
    let w = 0;
    let h = 0;
    let dpr = 1;
    let stopped = false;

    const resize = () => {
      dpr = Math.min(2, window.devicePixelRatio || 1);
      w = canvas.clientWidth || canvas.parentElement?.clientWidth || 0;
      h = canvas.clientHeight || 40;
      canvas.width = Math.max(1, Math.round(w * dpr));
      canvas.height = Math.max(1, Math.round(h * dpr));
    };
    resize();

    const frame = () => {
      if (stopped) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      ctx.globalCompositeOperation = 'lighter';
      if (activeRef.current) {
        const x = Math.max(2, Math.min(w - 2, fillRef.current * w));
        const y = h - 2;
        const n = 2 + ((Math.random() * 3) | 0);
        for (let i = 0; i < n; i++) {
          parts.push({
            x, y,
            vx: (Math.random() - 0.5) * 2.4,
            vy: -(1.4 + Math.random() * 3),
            g: 0.06 + Math.random() * 0.05,
            life: 1,
            s: 0.7 + Math.random() * 1.6,
            c: COLORS[(Math.random() * COLORS.length) | 0]!,
          });
        }
      }
      for (const p of parts) {
        p.vy += p.g; p.x += p.vx; p.y += p.vy; p.life -= 0.035;
        if (p.life <= 0) continue;
        ctx.globalAlpha = Math.max(0, p.life);
        ctx.fillStyle = p.c;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.s, 0, Math.PI * 2);
        ctx.fill();
      }
      for (let i = parts.length - 1; i >= 0; i--) if (parts[i]!.life <= 0) parts.splice(i, 1);
      ctx.globalAlpha = 1;
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    window.addEventListener('resize', resize);
    return () => { stopped = true; cancelAnimationFrame(raf); window.removeEventListener('resize', resize); };
  }, []);

  return <canvas ref={ref} className="bp__sparks" aria-hidden />;
}
