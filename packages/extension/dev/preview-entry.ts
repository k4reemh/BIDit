/** Standalone harness that mounts the real panel + winner overlay with mock data,
 *  so we can screenshot the injected UI without loading the extension into Chrome. */
import { createPanel } from '../src/panel.js';
import { showWinner } from '../src/winner.js';
import { showWheel } from '../src/wheel.js';
import { showGiveaway, type GiveawayHandle } from '../src/giveaway.js';
import { buildReel, buildRollOrder, type WheelEntry, type GiveawayEntrant, type GiveawayKind } from '@bidit/shared';
import panelCss from '../src/panel.css';

const host = document.getElementById('host')!;
const shadow = host.attachShadow({ mode: 'open' });
const style = document.createElement('style');
style.textContent = panelCss;
shadow.append(style);

const panel = createPanel({ onBid: (a) => console.log('bid', a), onSeedDemo: () => {} });
shadow.append(panel.root);
(window as unknown as { __panel: typeof panel }).__panel = panel; // dev/test hook

const IMG = 'https://images.pokemontcg.io/base1/4_hires.png';
panel.setConnected(true, 'luna_degen');
panel.setBalance('87', '100');

// Simulate a snipe war in the final seconds: each bid re-arms the deadline just
// inside the 5s window (so the panel stays red + heartbeating + glowing) and
// fires the EXTENDED flash — exactly the anti-snipe drama we're verifying.
const HANDLES = ['degen_max', 'cryptochad', 'luna_degen', 'apex_whale', 'mintking'];
let bid = 12;
let i = 0;
const snipe = (): void => {
  bid += 1 + Math.floor(Math.random() * 5); // varied jumps so the count-up roll shows
  const who = HANDLES[i++ % HANDLES.length]!;
  const now = Date.now();
  panel.applyState({
    type: 'AUCTION_STATE',
    room: 'demo',
    auctionId: 'demo-auction',
    title: 'Charizard — Base Set Holo',
    imageUrl: IMG,
    status: 'RUNNING',
    currentBid: String(bid),
    leaderHandle: who,
    minNextBid: String(bid + 1),
    durationSeconds: 20,
    endsAt: now + 4200, // inside the 5s window -> final-seconds drama
    serverNow: now,
  });
  panel.pushBid(who, String(bid));
  if (who === 'luna_degen') panel.showBidBurst(String(bid));
  panel.flashExtended();
};
snipe();
const loop = window.setInterval(snipe, 2600);

function mkBtn(id: string, label: string, left: number, bg: string, onClick: () => void): void {
  const b = document.createElement('button');
  b.id = id;
  b.textContent = label;
  b.style.cssText =
    `position:fixed;left:${left}px;bottom:20px;z-index:5;padding:11px 18px;border-radius:11px;border:0;` +
    `background:${bg};color:#06251a;font-weight:800;font-size:14px;cursor:pointer;font-family:system-ui;`;
  b.onclick = onClick;
  document.body.append(b);
}

mkBtn('flash', 'Flash EXTENDED', 20, '#ff7a45', () => panel.flashExtended());
mkBtn('pause', 'Pause snipes', 168, '#ffb020', () => window.clearInterval(loop));
mkBtn('replay', 'Replay win', 300, '#22e0a1', () =>
  showWinner(
    { winnerHandle: 'nadimnah', amount: '42', title: 'Charizard — Base Set Holo', imageUrl: IMG, isMe: true },
    600_000, // hold open for the screenshot
  ),
);

// Wheel-spin demo: same deterministic reel the server would broadcast.
const WHEEL: WheelEntry[] = [
  { label: 'Destined Rivals ETB', tier: 'Box' },
  { label: 'Sealed Booster Box', tier: 'Box' },
  { label: 'Charizard ex — Alt Art', tier: 'Chase' },
  { label: 'Pikachu ex — SIR', tier: 'SIR' },
  { label: 'Umbreon ex — SIR', tier: 'SIR' },
  { label: 'Sleeved Booster ×4', tier: 'Pack' },
  { label: 'Single Booster Pack', tier: 'Pack' },
  { label: 'Mystery Slab', tier: 'Slab' },
];
function spinWheel(prizeIndex: number, elapsedMs = -400, durationMs = 5200): void {
  window.clearInterval(loop);
  const { reel, targetIndex } = buildReel(WHEEL, prizeIndex);
  const now = Date.now();
  showWheel({
    reel,
    targetIndex,
    durationMs,
    startsAt: now - elapsedMs, // elapsedMs<0 starts in the future (normal); >0 jumps mid-spin for capture
    serverNow: now,
    winnerHandle: 'luna_degen',
    amount: '64',
    seedHash: '9f3a1c4e7b2d8a05f1',
    isMe: true,
    onLand: (prize) =>
      showWinner({ winnerHandle: 'luna_degen', amount: '64', title: prize.label, imageUrl: IMG, isMe: true }, 600_000),
  });
}
mkBtn('wheel', 'Spin wheel', 432, '#9b6bff', () => spinWheel(Math.floor(Math.random() * WHEEL.length)));
(window as unknown as { __spin: typeof spinWheel }).__spin = spinWheel; // dev/test hook

// Giveaway demo: entry card with entrants trickling in, then the winner reveal —
// the same GIVEAWAY_OPEN / GIVEAWAY_ENTRIES / GIVEAWAY_WINNER the server broadcasts.
const GA_HANDLES = [
  'degen_max', 'cryptochad', 'luna_degen', 'apex_whale', 'mintking',
  'pack_ripper', 'holo_hunter', 'slabgod', 'chase_queen', 'mint_maxi',
];
const GA_PRIZE = 'Charizard ex — Alt Art Slab';
let ga: GiveawayHandle | null = null;
let gaFill: number | undefined;

function openGiveaway(kind: GiveawayKind = 'PUBLIC', durationMs = 20_000): void {
  window.clearInterval(loop);
  if (gaFill) window.clearInterval(gaFill);
  const now = Date.now();
  ga = showGiveaway({
    giveawayId: 'demo-ga', kind, prize: GA_PRIZE, sellerHandle: 'kareem',
    opensAt: now, closesAt: now + durationMs, serverNow: now, entrantCount: 0, eligible: true,
    onEnter: () => ga?.markEntered(),
  });
  let entrants: GiveawayEntrant[] = [];
  gaFill = window.setInterval(() => {
    if (entrants.length >= GA_HANDLES.length) return;
    const h = GA_HANDLES[entrants.length]!;
    entrants = [{ userId: h, handle: h }, ...entrants];
    ga?.updateEntries(entrants.length + 23, entrants); // +23 so the "+N more" pill shows
  }, 450);
}

function revealGiveaway(winnerIdx = 3, kind: GiveawayKind = 'PUBLIC', startedMsAgo = -200): void {
  if (!ga) openGiveaway(kind);
  if (gaFill) window.clearInterval(gaFill);
  const entrants: GiveawayEntrant[] = GA_HANDLES.map((h) => ({ userId: h, handle: h }));
  const idx = ((winnerIdx % entrants.length) + entrants.length) % entrants.length;
  const { roll, targetIndex } = buildRollOrder(entrants, idx);
  const now = Date.now();
  const w = entrants[idx]!;
  ga!.reveal({
    prize: GA_PRIZE, winnerHandle: w.handle, roll, targetIndex,
    durationMs: 5200, startsAt: now - startedMsAgo, serverNow: now,
    seedHash: 'a1b2c3d4e5f6a7b8', isMe: w.handle === 'luna_degen',
  });
}

mkBtn('giveaway', 'Giveaway', 560, '#22e0a1', () => openGiveaway('PUBLIC'));
mkBtn('gadraw', 'Draw GA', 690, '#ffd34d', () => revealGiveaway(2));
(window as unknown as { __giveaway: { open: typeof openGiveaway; reveal: typeof revealGiveaway } }).__giveaway = {
  open: openGiveaway,
  reveal: revealGiveaway,
};
