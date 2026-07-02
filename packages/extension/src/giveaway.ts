/**
 * The giveaway spotlight — a full-viewport centred overlay (its own shadow root,
 * doesn't touch the page or the panel) for Whatnot-style giveaways.
 *
 * Two phases share one card:
 *   1. ENTRY   — prize + a live countdown + a growing pile of entrant avatars +
 *                a glowing ENTER button (the viewer taps once to enter).
 *   2. REVEAL  — a horizontal avatar strip hops through the entrants and settles
 *                on the winner, gold burst + confetti. Like the wheel, the hop is
 *                a pure function of the server's GIVEAWAY_WINNER (roll, target,
 *                duration, startsAt corrected for clock skew) so the seller and
 *                every viewer land together, and a late joiner still syncs.
 *
 * showGiveaway() returns a handle the content script drives as server messages
 * arrive: updateEntries / markEntered / reveal / close.
 */
import { makeAvatar } from './avatar.js';
import type { GiveawayEntrant, GiveawayKind } from '@bidit/shared';

const OVERLAY_ID = 'bidit-giveaway-overlay';
const TILE_W = 92; // width of one avatar tile on the reveal strip
const CENTER_TILES = 2; // tiles left of the spotlight in the visible window

export interface GiveawayOpenOpts {
  giveawayId: string;
  kind: GiveawayKind;
  prize: string;
  sellerHandle: string;
  opensAt: number;
  closesAt: number;
  serverNow: number;
  entrantCount: number;
  /** Whether this viewer is eligible to enter (drives the button copy). */
  eligible: boolean;
  onEnter: () => void;
}

export interface GiveawayRevealOpts {
  prize: string;
  winnerHandle: string;
  roll: GiveawayEntrant[];
  targetIndex: number;
  durationMs: number;
  startsAt: number;
  serverNow: number;
  seedHash: string;
  isMe: boolean;
}

export interface GiveawayHandle {
  giveawayId: string;
  updateEntries: (count: number, recent: GiveawayEntrant[]) => void;
  markEntered: () => void;
  markRejected: (reason: string) => void;
  reveal: (opts: GiveawayRevealOpts) => void;
  close: () => void;
}

const KIND_META: Record<GiveawayKind, { label: string; color: string }> = {
  PUBLIC: { label: 'Everyone', color: '#22e0a1' },
  BUYER_ONLY: { label: 'Buyers only', color: '#ffd34d' },
};

const CSS = `
.scrim { position: fixed; inset: 0; display: flex; align-items: center; justify-content: center;
  background: radial-gradient(60% 60% at 50% 44%, rgba(5,8,13,0.82), rgba(5,8,13,0.55)); }
.confetti { position: fixed; inset: 0; pointer-events: none; }
.card {
  position: relative; width: 430px; padding: 24px 24px 22px; text-align: center;
  border-radius: 26px; color: #eaf0fb; font-family: "Inter", -apple-system, system-ui, sans-serif;
  background: rgba(11,14,20,0.96); border: 1px solid rgba(255,255,255,0.08);
  box-shadow: 0 30px 90px rgba(0,0,0,0.6), 0 0 90px rgba(34,224,161,0.20);
  animation: pop 0.5s cubic-bezier(0.18,0.9,0.3,1.32) both;
}
.card.win { border-color: rgba(255,211,77,0.45); box-shadow: 0 30px 90px rgba(0,0,0,0.6), 0 0 90px rgba(255,211,77,0.34); }
.card.out { animation: out 0.45s ease forwards; }
.top { display: flex; align-items: center; justify-content: center; gap: 8px; }
.brand { font-weight: 800; font-size: 15px; letter-spacing: 0.02em; }
.brand .g { font-size: 17px; }
.brand .b { background: linear-gradient(90deg, #22e0a1, #4f8cff); -webkit-background-clip: text; background-clip: text; color: transparent; }
.kind { display: inline-flex; align-items: center; gap: 6px; margin-left: 4px; padding: 3px 10px; border-radius: 999px;
  font-size: 11px; font-weight: 800; letter-spacing: 0.05em; text-transform: uppercase; }
.kind i { width: 6px; height: 6px; border-radius: 50%; }
.kicker { margin-top: 16px; font-size: 11px; font-weight: 800; letter-spacing: 0.16em; text-transform: uppercase; color: #8a93a7; }
.prize { margin-top: 5px; font-size: 27px; font-weight: 900; letter-spacing: -0.01em; line-height: 1.12;
  background: linear-gradient(90deg, #eaf0fb, #b9c6dc); -webkit-background-clip: text; background-clip: text; color: transparent; }
.host { margin-top: 6px; font-size: 12.5px; color: #8a93a7; }

/* countdown */
.count { margin-top: 16px; display: flex; align-items: baseline; justify-content: center; gap: 6px; }
.count b { font-size: 30px; font-weight: 900; font-variant-numeric: tabular-nums; }
.count span { font-size: 12px; color: #8a93a7; font-weight: 700; }
.count.low b { color: #ff5470; }
.bar { position: relative; height: 6px; margin: 12px 6px 0; border-radius: 999px; background: rgba(255,255,255,0.08); overflow: hidden; }
.bar > i { position: absolute; left: 0; top: 0; bottom: 0; border-radius: 999px;
  background: linear-gradient(90deg, #22e0a1, #4f8cff); transition: width 0.12s linear; }
.bar.low > i { background: linear-gradient(90deg, #ff5470, #ff8a5b); }

/* entrant pile */
.entered { margin-top: 18px; }
.avs { display: flex; align-items: center; justify-content: center; flex-wrap: wrap; gap: 6px; min-height: 34px; }
.avs .av { animation: avin 0.4s cubic-bezier(0.18,0.9,0.3,1.5) both; box-shadow: 0 0 0 2px rgba(11,14,20,1); border-radius: 50%; }
.avs .more { display: inline-flex; align-items: center; justify-content: center; height: 30px; min-width: 30px; padding: 0 8px;
  border-radius: 999px; background: rgba(255,255,255,0.08); font-size: 12px; font-weight: 800; color: #cdd6e6; }
.tally { margin-top: 10px; font-size: 13px; color: #aeb8c9; font-weight: 600; }
.tally b { color: #eaf0fb; font-variant-numeric: tabular-nums; }

/* enter button */
.enter { margin-top: 16px; width: 100%; height: 52px; border-radius: 15px; font-size: 17px; font-weight: 900; letter-spacing: 0.01em;
  color: #04120c; background: linear-gradient(180deg, #34eaad, #12b981);
  box-shadow: 0 10px 26px rgba(34,224,161,0.4), inset 0 1px 0 rgba(255,255,255,0.4); cursor: pointer;
  transition: transform 0.1s ease, filter 0.15s ease; animation: glow 2s ease-in-out infinite; }
.enter:hover { filter: brightness(1.06); }
.enter:active { transform: translateY(1px) scale(0.99); }
.enter.done { background: rgba(34,224,161,0.16); color: #34eaad; box-shadow: none; cursor: default; animation: none; }
.enter.blocked { background: rgba(255,255,255,0.07); color: #8a93a7; box-shadow: none; cursor: not-allowed; animation: none; }
.note { margin-top: 10px; font-size: 11.5px; color: #7c8598; }

/* reveal strip */
.reel { position: relative; height: ${TILE_W + 26}px; margin: 18px 0 4px; border-radius: 18px; overflow: hidden;
  background: #070a10; border: 1px solid rgba(255,255,255,0.07); }
.spot { position: absolute; top: 50%; left: ${TILE_W * CENTER_TILES + TILE_W / 2}px; transform: translate(-50%,-50%);
  width: ${TILE_W - 8}px; height: ${TILE_W - 8}px; border-radius: 18px; z-index: 2; pointer-events: none;
  border: 2px solid rgba(255,211,77,0.85); box-shadow: 0 0 30px rgba(255,211,77,0.4), 0 0 0 2000px rgba(5,8,13,0.35); }
.spot.land { animation: spotland 0.5s ease; }
.strip { position: absolute; top: 13px; left: 0; display: flex; will-change: transform; }
.tile { width: ${TILE_W}px; display: flex; flex-direction: column; align-items: center; gap: 6px; }
.tile .av { border-radius: 16px; box-shadow: 0 0 0 2px rgba(255,255,255,0.06); }
.tile .h { max-width: ${TILE_W - 8}px; font-size: 10.5px; font-weight: 700; color: #9fb0c8; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.fade { position: absolute; top: 0; bottom: 0; width: 64px; z-index: 3; pointer-events: none; }
.fade.l { left: 0; background: linear-gradient(90deg, #070a10, rgba(7,10,16,0)); }
.fade.r { right: 0; background: linear-gradient(270deg, #070a10, rgba(7,10,16,0)); }

/* winner */
.wrap { display: none; }
.wrap.show { display: block; animation: rise 0.5s cubic-bezier(0.16,0.95,0.28,1) both; }
.wbig { margin: 4px auto 12px; box-shadow: 0 0 0 4px rgba(255,211,77,0.2), 0 0 40px rgba(255,211,77,0.6); border-radius: 22px; }
.wkick { font-size: 12px; font-weight: 800; letter-spacing: 0.16em; text-transform: uppercase; color: #ffd34d; }
.whead { margin-top: 3px; font-size: 26px; font-weight: 900; letter-spacing: -0.01em;
  background: linear-gradient(90deg, #ffe27a, #ffb020); -webkit-background-clip: text; background-clip: text; color: transparent; }
.wprize { margin-top: 8px; font-size: 15px; font-weight: 700; color: #eaf0fb; }
.wprize b { color: #ffd34d; }
.fair { margin-top: 14px; display: inline-flex; align-items: center; gap: 6px; font-size: 11px; color: #8a93a7; }
.fair i { width: 6px; height: 6px; border-radius: 50%; background: #22e0a1; }
.fair code { color: #9cc0ff; font-family: ui-monospace, SFMono-Regular, monospace; }

@keyframes pop { 0% { transform: scale(0.72) translateY(18px); opacity: 0; } 100% { transform: scale(1) translateY(0); opacity: 1; } }
@keyframes out { to { transform: scale(0.96) translateY(8px); opacity: 0; } }
@keyframes avin { 0% { transform: scale(0) translateY(-8px); opacity: 0; } 100% { transform: scale(1) translateY(0); opacity: 1; } }
@keyframes glow { 0%,100% { box-shadow: 0 10px 26px rgba(34,224,161,0.34), inset 0 1px 0 rgba(255,255,255,0.4); }
  50% { box-shadow: 0 10px 34px rgba(34,224,161,0.62), inset 0 1px 0 rgba(255,255,255,0.4); } }
@keyframes rise { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
@keyframes spotland { 0% { transform: translate(-50%,-50%) scale(1); } 45% { transform: translate(-50%,-50%) scale(1.12); } 100% { transform: translate(-50%,-50%) scale(1); } }
`;

function el(tag: string, cls?: string): HTMLElement {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  return n;
}
const easeOutQuart = (p: number): number => 1 - Math.pow(1 - p, 4);

export function showGiveaway(opts: GiveawayOpenOpts): GiveawayHandle {
  document.getElementById(OVERLAY_ID)?.remove();

  const host = document.createElement('div');
  host.id = OVERLAY_ID;
  host.style.cssText = 'position:fixed;inset:0;z-index:2147483646;pointer-events:none;';
  const shadow = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = CSS;
  shadow.append(style);

  const scrim = el('div', 'scrim');
  scrim.style.pointerEvents = 'auto';
  const canvas = document.createElement('canvas');
  canvas.className = 'confetti';
  const card = el('div', 'card');

  const meta = KIND_META[opts.kind];

  // --- header ---
  const top = el('div', 'top');
  const brand = el('div', 'brand');
  brand.innerHTML = '<span class="g">🎁</span> <span class="b">BID</span>it giveaway';
  const kind = el('span', 'kind');
  kind.style.color = meta.color;
  kind.style.background = `${meta.color}22`;
  kind.innerHTML = `<i style="background:${meta.color}"></i>${meta.label}`;
  top.append(brand, kind);

  const kicker = el('div', 'kicker');
  kicker.textContent = 'Up for grabs';
  const prize = el('div', 'prize');
  prize.textContent = opts.prize;
  const hostLine = el('div', 'host');
  hostLine.textContent = `from @${opts.sellerHandle}`;

  // --- countdown ---
  const count = el('div', 'count');
  const countNum = document.createElement('b');
  const countUnit = el('span');
  countUnit.textContent = 'left to enter';
  count.append(countNum, countUnit);
  const bar = el('div', 'bar');
  const barFill = el('i');
  bar.append(barFill);

  // --- entrant pile ---
  const entered = el('div', 'entered');
  const avs = el('div', 'avs');
  const tally = el('div', 'tally');
  entered.append(avs, tally);

  // --- enter button ---
  const enterBtn = document.createElement('button');
  enterBtn.className = opts.eligible ? 'enter' : 'enter blocked';
  enterBtn.textContent = opts.eligible ? 'Enter giveaway' : 'Buyers only — purchase to enter';
  let entered_ = false;
  enterBtn.onclick = () => {
    if (entered_ || !opts.eligible) return;
    opts.onEnter();
  };

  const note = el('div', 'note');
  note.textContent =
    opts.kind === 'BUYER_ONLY'
      ? 'Only people who bought from this seller can win.'
      : 'Free to enter · one entry per viewer.';

  // --- reveal (built now, revealed later) ---
  const reel = el('div', 'reel');
  reel.style.display = 'none';
  const spot = el('div', 'spot');
  const strip = el('div', 'strip');
  const fadeL = el('div', 'fade l');
  const fadeR = el('div', 'fade r');
  reel.append(strip, spot, fadeL, fadeR);

  const winWrap = el('div', 'wrap');

  card.append(top, kicker, prize, hostLine, count, bar, entered, enterBtn, note, reel, winWrap);
  scrim.append(canvas, card);
  shadow.append(scrim);
  document.body.append(host);

  // ---- entry-phase state ----
  const offset = opts.serverNow - Date.now();
  const span = Math.max(1, opts.closesAt - opts.opensAt);
  let count_ = opts.entrantCount;
  let recent_: GiveawayEntrant[] = [];
  let revealing = false;
  let removed = false;

  const renderPile = (): void => {
    avs.replaceChildren();
    const show = recent_.slice(0, 7);
    for (const e of show) {
      const av = makeAvatar(e.handle, 30);
      av.classList.add('av');
      avs.append(av);
    }
    const extra = count_ - show.length;
    if (extra > 0) {
      const more = el('span', 'more');
      more.textContent = `+${extra}`;
      avs.append(more);
    }
    tally.innerHTML = count_ === 0 ? 'Be the first to enter' : `<b>${count_}</b> ${count_ === 1 ? 'viewer' : 'viewers'} entered`;
  };
  renderPile();

  let raf = 0;
  const tick = (): void => {
    if (revealing || removed) return;
    const now = Date.now() + offset;
    const remainMs = Math.max(0, opts.closesAt - now);
    const secs = remainMs / 1000;
    countNum.textContent = secs >= 10 ? Math.ceil(secs).toString() : secs.toFixed(1);
    const pct = Math.max(0, Math.min(100, (remainMs / span) * 100));
    barFill.style.width = `${pct}%`;
    const low = remainMs <= 5000;
    count.classList.toggle('low', low);
    bar.classList.toggle('low', low);
    if (remainMs <= 0) {
      countUnit.textContent = 'drawing…';
      countNum.textContent = '0';
      return; // stop ticking; wait for GIVEAWAY_WINNER
    }
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);

  // ---- reveal phase ----
  const reveal = (r: GiveawayRevealOpts): void => {
    if (removed) return;
    revealing = true;
    cancelAnimationFrame(raf);
    // collapse the entry chrome
    for (const n of [kicker, count, bar, entered, enterBtn, note]) (n as HTMLElement).style.display = 'none';
    kicker.textContent = 'Drawing the winner';
    reel.style.display = 'block';

    for (const e of r.roll) {
      const tile = el('div', 'tile');
      const av = makeAvatar(e.handle, TILE_W - 20);
      av.classList.add('av');
      const h = el('div', 'h');
      h.textContent = `@${e.handle}`;
      tile.append(av, h);
      strip.append(tile);
    }

    const roffset = r.serverNow - Date.now();
    const startX = CENTER_TILES * TILE_W; // roll tile 0 centred under spotlight
    const endX = (CENTER_TILES - r.targetIndex) * TILE_W; // winner centred
    let landed = false;

    const land = (): void => {
      if (landed) return;
      landed = true;
      strip.style.transform = `translateX(${endX}px)`;
      spot.classList.add('land');
      // winner card
      card.classList.add('win');
      const wbig = makeAvatar(r.winnerHandle, 76);
      wbig.classList.add('wbig');
      const wkick = el('div', 'wkick');
      wkick.textContent = r.isMe ? 'You won!' : 'Winner';
      const whead = el('div', 'whead');
      whead.textContent = r.isMe ? '🎉 YOU WON! 🎉' : `@${r.winnerHandle}`;
      const wprize = el('div', 'wprize');
      wprize.innerHTML = `wins <b>${r.prize}</b>`;
      const fair = el('div', 'fair');
      fair.innerHTML = `<i></i> Provably fair · seed <code>${r.seedHash.slice(0, 10)}…</code>`;
      winWrap.append(wbig, wkick, whead, wprize, fair);
      winWrap.classList.add('show');
      runConfetti(canvas);
      window.setTimeout(() => card.classList.add('out'), 5200);
      window.setTimeout(() => api.close(), 5650);
    };

    const frame = (): void => {
      if (removed) return;
      const elapsed = Date.now() + roffset - r.startsAt;
      const p = Math.max(0, Math.min(1, elapsed / r.durationMs));
      const x = startX + (endX - startX) * easeOutQuart(p);
      strip.style.transform = `translateX(${x}px)`;
      if (p >= 1) land();
      else requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  };

  const api: GiveawayHandle = {
    giveawayId: opts.giveawayId,
    updateEntries: (c, recent) => {
      if (revealing) return;
      count_ = c;
      recent_ = recent;
      renderPile();
    },
    markEntered: () => {
      entered_ = true;
      enterBtn.className = 'enter done';
      enterBtn.textContent = "You're in ✓";
    },
    markRejected: (reason) => {
      enterBtn.className = 'enter blocked';
      enterBtn.textContent =
        reason === 'NOT_ELIGIBLE' ? 'Buyers only — purchase to enter' : 'Entry closed';
    },
    reveal,
    close: () => {
      if (removed) return;
      removed = true;
      cancelAnimationFrame(raf);
      host.remove();
    },
  };
  return api;
}

function runConfetti(canvas: HTMLCanvasElement): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const W = (canvas.width = window.innerWidth * dpr);
  const H = (canvas.height = window.innerHeight * dpr);
  canvas.style.width = `${window.innerWidth}px`;
  canvas.style.height = `${window.innerHeight}px`;
  const colors = ['#ffd34d', '#22e0a1', '#4f8cff', '#ff7a45', '#ffffff'];
  const parts = Array.from({ length: 180 }, () => ({
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
      if (t - start > 2600) p.life -= 0.017 * dt;
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
    if (alive && t - start < 5200) requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}
