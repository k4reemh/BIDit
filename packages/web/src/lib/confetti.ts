/** Shared confetti burst for celebratory overlays (auction win, giveaway, wheel). */
export function runConfetti(
  canvas: HTMLCanvasElement | null,
  colors: string[] = ['#f5c518', '#0e9f6e', '#4f8cff', '#ff7a45', '#e5484d', '#ffffff'],
  count = 140,
  durationMs = 5600,
): void {
  const ctx = canvas?.getContext('2d');
  if (!canvas || !ctx) return;
  // Cap DPR at 1.5 — a full-screen clearRect at native 4K every frame is the main
  // cost and reads as jank; 1.5 is indistinguishable for confetti.
  const dpr = Math.min(1.5, window.devicePixelRatio || 1);
  const W = (canvas.width = window.innerWidth * dpr);
  const H = (canvas.height = window.innerHeight * dpr);
  canvas.style.width = `${window.innerWidth}px`;
  canvas.style.height = `${window.innerHeight}px`;
  const parts = Array.from({ length: count }, () => ({
    x: W * (0.3 + Math.random() * 0.4),
    y: H * 0.4 + (Math.random() - 0.5) * 40 * dpr,
    vx: (Math.random() - 0.5) * 16 * dpr,
    vy: (-9 - Math.random() * 12) * dpr,
    g: 0.36 * dpr,
    s: (5 + Math.random() * 7) * dpr,
    rot: Math.random() * 6,
    vr: (Math.random() - 0.5) * 0.4,
    c: colors[(Math.random() * colors.length) | 0]!,
    life: 1,
  }));
  const start = performance.now();
  let last = start;
  const frame = (t: number): void => {
    const dt = Math.min(2.5, (t - last) / 16);
    last = t;
    ctx.clearRect(0, 0, W, H);
    let alive = false;
    for (const p of parts) {
      p.vy += p.g * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.rot += p.vr * dt;
      if (t - start > durationMs / 2) p.life -= 0.017 * dt;
      if (p.life <= 0 || p.y > H + 40) continue;
      alive = true;
      ctx.save();
      ctx.globalAlpha = Math.max(0, p.life);
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.fillStyle = p.c;
      ctx.fillRect(-p.s / 2, -p.s / 2, p.s, p.s * 0.6);
      ctx.restore();
    }
    if (alive && t - start < durationMs) requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}
