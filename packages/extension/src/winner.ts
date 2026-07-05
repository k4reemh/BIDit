/**
 * The auction-win celebration — a full-viewport overlay injected over the stream
 * (its own shadow root, doesn't touch the page or the panel). 3D pop-in +
 * confetti, two flavors (you won vs someone else won), and the BIDit twist: it
 * shows how much of the sale routed to the $BID buyback. Auto-dismisses.
 */
import { makeAvatar } from './avatar.js';

const OVERLAY_ID = 'bidit-winner-overlay';

export interface WinnerOpts {
  winnerHandle: string;
  amount: string; // human USDC decimal, e.g. "42"
  title: string;
  imageUrl: string | null;
  isMe: boolean;
}

const CSS = `
.scrim { position: fixed; inset: 0; display: flex; align-items: center; justify-content: center;
  background: radial-gradient(60% 60% at 50% 42%, rgba(6,9,14,0.55), rgba(6,9,14,0.18)); }
.confetti { position: fixed; inset: 0; pointer-events: none; }
.card {
  position: relative; width: 320px; padding: 28px 28px 22px; text-align: center;
  border-radius: 24px; color: #eef3fb; font-family: "Inter", -apple-system, system-ui, sans-serif;
  background: rgba(12,16,24,0.94); border: 1px solid rgba(255,255,255,0.08);
  box-shadow: 0 30px 90px rgba(0,0,0,0.6), 0 0 70px rgba(34,224,161,0.28);
  animation: pop 0.62s cubic-bezier(0.18,0.9,0.3,1.35) both;
}
.card.me { border-color: rgba(255,211,77,0.45); box-shadow: 0 30px 90px rgba(0,0,0,0.6), 0 0 80px rgba(255,211,77,0.4); }
.card.out { animation: out 0.5s ease forwards; }
.bigav { margin: 0 auto 14px; box-shadow: 0 0 0 4px rgba(255,255,255,0.08), 0 0 34px rgba(34,224,161,0.5); }
.card.me .bigav { box-shadow: 0 0 0 4px rgba(255,211,77,0.18), 0 0 36px rgba(255,211,77,0.6); }
.kicker { font-size: 12px; font-weight: 800; letter-spacing: 0.14em; text-transform: uppercase; color: #22e0a1; }
.card.me .kicker { color: #ffd34d; }
.headline { font-size: 26px; font-weight: 900; letter-spacing: -0.01em; line-height: 1.1; margin-top: 3px; }
.card.me .headline {
  background: linear-gradient(90deg, #ffe27a, #ffb020); -webkit-background-clip: text; background-clip: text; color: transparent;
}
.item { display: flex; align-items: center; gap: 9px; justify-content: center; margin: 16px 0 4px; }
.item img { width: 38px; height: 38px; border-radius: 9px; object-fit: cover; background: #11151d; }
.item span { font-weight: 700; font-size: 14px; max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.price { font-size: 42px; font-weight: 900; letter-spacing: -0.02em; margin-top: 4px; font-variant-numeric: tabular-nums; }
.buyback { margin-top: 12px; display: inline-flex; align-items: center; gap: 6px; padding: 6px 13px; border-radius: 999px;
  font-size: 12.5px; font-weight: 800; color: #22e0a1; background: rgba(34,224,161,0.13); }
@keyframes pop {
  0% { transform: perspective(700px) rotateX(14deg) scale(0.6) translateY(26px); opacity: 0; }
  100% { transform: perspective(700px) rotateX(0) scale(1) translateY(0); opacity: 1; }
}
@keyframes out { to { transform: scale(0.95) translateY(10px); opacity: 0; } }
`;

function el(tag: string, cls?: string): HTMLElement {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  return n;
}

export function showWinner(opts: WinnerOpts, holdMs = 4200): void {
  document.getElementById(OVERLAY_ID)?.remove();

  const host = document.createElement('div');
  host.id = OVERLAY_ID;
  host.style.cssText = 'position:fixed;inset:0;z-index:2147483647;pointer-events:none;';
  const shadow = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = CSS;
  shadow.append(style);

  const scrim = el('div', 'scrim');
  const canvas = document.createElement('canvas');
  canvas.className = 'confetti';
  const card = el('div', `card ${opts.isMe ? 'me' : ''}`);

  const av = makeAvatar(opts.winnerHandle, 76);
  av.classList.add('bigav');
  const kicker = el('div', 'kicker');
  kicker.textContent = opts.isMe ? 'You won' : 'Sold';
  const headline = el('div', 'headline');
  headline.textContent = opts.isMe ? 'WINNER!' : `${opts.winnerHandle} won`;

  const item = el('div', 'item');
  if (opts.imageUrl) {
    const img = document.createElement('img');
    img.src = opts.imageUrl;
    item.append(img);
  }
  const itemName = document.createElement('span');
  itemName.textContent = opts.title;
  item.append(itemName);

  const price = el('div', 'price');
  price.textContent = `$${opts.amount}`;

  const buyback = el('div', 'buyback');
  const pumped = (parseFloat(opts.amount) * 0.05 || 0).toFixed(2);
  buyback.textContent = `+$${pumped} → $BID buyback`;

  card.append(av, kicker, headline, item, price, buyback);
  scrim.append(canvas, card);
  shadow.append(scrim);
  document.body.append(host);

  runConfetti(canvas, opts.isMe);
  window.setTimeout(() => card.classList.add('out'), Math.max(0, holdMs - 600));
  window.setTimeout(() => host.remove(), holdMs);
}

function runConfetti(canvas: HTMLCanvasElement, big: boolean): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const W = (canvas.width = window.innerWidth * dpr);
  const H = (canvas.height = window.innerHeight * dpr);
  canvas.style.width = `${window.innerWidth}px`;
  canvas.style.height = `${window.innerHeight}px`;

  const colors = big
    ? ['#ffd34d', '#22e0a1', '#4f8cff', '#ff7a45', '#ffffff']
    : ['#22e0a1', '#4f8cff', '#9b6bff'];
  const n = big ? 170 : 80;
  const parts = Array.from({ length: n }, () => ({
    x: W * (0.32 + Math.random() * 0.36),
    y: H * 0.36 + (Math.random() - 0.5) * 40 * dpr,
    vx: (Math.random() - 0.5) * 15 * dpr,
    vy: (-9 - Math.random() * 11) * dpr,
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
      if (t - start > 2400) p.life -= 0.018 * dt;
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
    if (alive && t - start < 4200) requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}
