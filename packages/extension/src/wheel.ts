/**
 * The wheel-spin spotlight — a full-viewport centred overlay (its own shadow
 * root, doesn't touch the page or the panel) that plays the randomizer reel.
 *
 * It is a pure replay of the server's RANDOMIZER_SPIN: the reel, the landing
 * index and the duration all come from the server, and the position is computed
 * from `startsAt` corrected for clock skew — so the seller and every viewer see
 * the identical reel decelerate onto the identical prize, in lockstep. A late
 * joiner picks up mid-spin and still lands with everyone else. When it settles
 * it hands off to the win celebration via `onLand`.
 */
import { makeAvatar } from './avatar.js';
import type { ReelSlot } from '@bidit/shared';

const OVERLAY_ID = 'bidit-wheel-overlay';
const ROW_H = 76;
const WINDOW_ROWS = 5;
const CENTER_SLOT = 2; // 0-based index of the highlighted row in the window

export interface WheelSpinOpts {
  reel: ReelSlot[];
  targetIndex: number;
  durationMs: number;
  startsAt: number;
  serverNow: number;
  winnerHandle: string;
  amount: string;
  seedHash: string;
  isMe: boolean;
  /** Called once the reel settles, with the prize it landed on. */
  onLand: (prize: ReelSlot) => void;
}

const TIER_COLOR: Record<string, string> = {
  Box: '#4f8cff',
  Chase: '#ff4d6d',
  Pack: '#22e0a1',
  Slab: '#ffb020',
  SIR: '#ff7a45',
};
const tierColor = (tier?: string): string => (tier && TIER_COLOR[tier]) || '#9b6bff';

const CSS = `
.scrim { position: fixed; inset: 0; display: flex; align-items: center; justify-content: center;
  background: radial-gradient(62% 62% at 50% 46%, rgba(5,8,13,0.82), rgba(5,8,13,0.6)); }
.card {
  position: relative; width: 420px; padding: 22px 22px 20px; text-align: center;
  border-radius: 24px; color: #eaf0fb; font-family: "Inter", -apple-system, system-ui, sans-serif;
  background: rgba(11,14,20,0.96);
  border: 1px solid rgba(255,255,255,0.08);
  box-shadow: 0 30px 90px rgba(0,0,0,0.6), 0 0 80px rgba(255,106,0,0.20);
  animation: pop 0.5s cubic-bezier(0.18,0.9,0.3,1.3) both;
}
.brand { font-weight: 800; font-size: 16px; color: #ff6a00; }
.brand .b { color: #ffffff; }
.kicker { margin-top: 14px; font-size: 11px; font-weight: 800; letter-spacing: 0.14em; text-transform: uppercase; color: #8a93a7; }
.who { display: inline-flex; align-items: center; gap: 8px; margin-top: 6px; font-size: 20px; font-weight: 800; }
.window { position: relative; height: ${ROW_H * WINDOW_ROWS}px; margin-top: 16px; border-radius: 16px; overflow: hidden;
  background: #070a10; border: 1px solid rgba(255,255,255,0.07); }
.band { position: absolute; left: 10px; right: 10px; top: ${ROW_H * CENTER_SLOT}px; height: ${ROW_H}px;
  border-radius: 12px; background: linear-gradient(90deg, rgba(255,106,0,0.16), rgba(255,138,60,0.16));
  border: 1.5px solid rgba(255,106,0,0.55); box-shadow: 0 0 26px rgba(255,106,0,0.20) inset; z-index: 2; pointer-events: none; }
.band.land { animation: land 0.5s ease; }
.strip { position: absolute; left: 0; right: 0; top: 0; will-change: transform; }
.row { height: ${ROW_H}px; display: flex; align-items: center; gap: 12px; padding: 0 22px; box-sizing: border-box; }
.row .dot { width: 11px; height: 11px; border-radius: 50%; flex: none; }
.row .name { font-size: 19px; font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.row .tier { margin-left: auto; font-size: 11px; font-weight: 800; letter-spacing: 0.06em; text-transform: uppercase; }
.fade { position: absolute; left: 0; right: 0; height: ${ROW_H}px; z-index: 3; pointer-events: none; }
.fade.top { top: 0; background: linear-gradient(#070a10, rgba(7,10,16,0)); }
.fade.bot { bottom: 0; background: linear-gradient(rgba(7,10,16,0), #070a10); }
.prize { height: 26px; margin-top: 14px; font-size: 17px; font-weight: 900; opacity: 0; }
.prize.show { animation: rise 0.5s cubic-bezier(0.16,0.95,0.28,1) forwards; }
.fair { margin-top: 12px; display: inline-flex; align-items: center; gap: 6px; font-size: 11px; color: #8a93a7; }
.fair i { width: 6px; height: 6px; border-radius: 50%; background: #ff6a00; }
.fair code { color: #cbd5e1; font-family: ui-monospace, SFMono-Regular, monospace; }
.card.out { animation: out 0.45s ease forwards; }
@keyframes pop { 0% { transform: scale(0.7) translateY(20px); opacity: 0; } 100% { transform: scale(1) translateY(0); opacity: 1; } }
@keyframes out { to { transform: scale(0.96) translateY(8px); opacity: 0; } }
@keyframes land { 0% { transform: scale(1); } 40% { transform: scale(1.04); box-shadow: 0 0 40px rgba(255,106,0,0.6) inset; } 100% { transform: scale(1); } }
@keyframes rise { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
`;

function el(tag: string, cls?: string): HTMLElement {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  return n;
}

const easeOutQuart = (p: number): number => 1 - Math.pow(1 - p, 4);

export function showWheel(opts: WheelSpinOpts): void {
  document.getElementById(OVERLAY_ID)?.remove();

  const host = document.createElement('div');
  host.id = OVERLAY_ID;
  host.style.cssText = 'position:fixed;inset:0;z-index:2147483646;pointer-events:none;';
  const shadow = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = CSS;
  shadow.append(style);

  const scrim = el('div', 'scrim');
  const card = el('div', 'card');

  const brand = el('div', 'brand');
  brand.innerHTML = '<span class="b">BID</span>it · WHEEL';
  const kicker = el('div', 'kicker');
  kicker.textContent = opts.isMe ? 'Spinning for you' : 'Assigning roll for';
  const who = el('div', 'who');
  const av = makeAvatar(opts.winnerHandle, 24);
  who.append(av, document.createTextNode(`@${opts.winnerHandle}`));

  const win = el('div', 'window');
  const band = el('div', 'band');
  const strip = el('div', 'strip');
  for (const slot of opts.reel) {
    const row = el('div', 'row');
    const dot = el('span', 'dot');
    dot.style.background = tierColor(slot.tier);
    dot.style.boxShadow = `0 0 8px ${tierColor(slot.tier)}80`;
    const name = el('span', 'name');
    name.textContent = slot.label;
    const tier = el('span', 'tier');
    tier.textContent = slot.tier ?? '';
    tier.style.color = tierColor(slot.tier);
    row.append(dot, name, tier);
    strip.append(row);
  }
  const fadeTop = el('div', 'fade top');
  const fadeBot = el('div', 'fade bot');
  win.append(strip, band, fadeTop, fadeBot);

  const prizeEl = el('div', 'prize');
  const fair = el('div', 'fair');
  fair.innerHTML = `<i></i> Provably fair · seed <code>${opts.seedHash.slice(0, 10)}…</code>`;

  card.append(brand, kicker, who, win, prizeEl, fair);
  scrim.append(card);
  shadow.append(scrim);
  document.body.append(host);

  // Position is a pure function of server time, so everyone is in lockstep.
  const offset = opts.serverNow - Date.now();
  const startY = CENTER_SLOT * ROW_H; // reel row 0 centred
  const endY = (CENTER_SLOT - opts.targetIndex) * ROW_H; // prize centred
  const prize = opts.reel[opts.targetIndex] ?? opts.reel[opts.reel.length - 1]!;

  let landed = false;
  const land = (): void => {
    if (landed) return;
    landed = true;
    strip.style.transform = `translateY(${endY}px)`;
    band.classList.add('land');
    prizeEl.style.color = tierColor(prize.tier);
    prizeEl.textContent = `${prize.label}`;
    prizeEl.classList.add('show');
    window.setTimeout(() => opts.onLand(prize), 850);
    window.setTimeout(() => card.classList.add('out'), 1500);
    window.setTimeout(() => host.remove(), 1950);
  };

  const frame = (): void => {
    const elapsed = Date.now() + offset - opts.startsAt;
    const p = Math.max(0, Math.min(1, elapsed / opts.durationMs));
    const y = startY + (endY - startY) * easeOutQuart(p);
    strip.style.transform = `translateY(${y}px)`;
    if (p >= 1) land();
    else requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}
