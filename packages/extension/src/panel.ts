/**
 * The injected auction panel — pure DOM, no chrome.* APIs, so the content script
 * and the dev preview harness share it. Renders authoritative server state and
 * surfaces user intent via callbacks; computes nothing financial. The only local
 * work is ticking the countdown (synced to server time) and the micro-animations.
 */
import type {
  AuctionStateMessage,
  AuctionClosedMessage,
  BidRejectedMessage,
  RealtimeRejectReason,
} from '@bidit/shared';
import { makeAvatar } from './avatar.js';

export interface PanelHandlers {
  onBid: (amount: string) => void;
  onSeedDemo?: () => void;
}

export interface PanelHandle {
  root: HTMLElement;
  setConnected(connected: boolean, handle: string | null): void;
  setBalance(available: string | null, settled: string | null): void;
  applyState(s: AuctionStateMessage): void;
  applyClosed(c: AuctionClosedMessage): void;
  applyRejected(r: BidRejectedMessage): void;
  pushBid(handle: string, amount: string): void;
  /** Your bid was accepted — throw a short +$X burst off the button. */
  showBidBurst(amount: string): void;
  /** Anti-snipe: a late bid pushed the deadline — flash the "EXTENDED!" badge. */
  flashExtended(): void;
  setStatus(text: string, kind?: StatusKind): void;
  setNoAuction(linked: boolean): void;
  destroy(): void;
}

type StatusKind = 'info' | 'error' | 'outbid' | 'leading';

const REJECT_TEXT: Record<RealtimeRejectReason, [string, StatusKind]> = {
  INSUFFICIENT_BALANCE: ['Not enough balance — add funds', 'error'],
  BID_TOO_LOW: ['Too low — try the suggested bid', 'error'],
  ALREADY_LEADING: ["You're already winning 🔥", 'leading'],
  AUCTION_ENDED: ['Auction has ended', 'info'],
  AUCTION_NOT_FOUND: ['Auction not found', 'error'],
  RATE_LIMITED: ['Slow down — too many bids', 'error'],
};

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** Replay a CSS animation by toggling the class off→on. */
function pulse(node: HTMLElement, cls: string): void {
  node.classList.remove(cls);
  void node.offsetWidth;
  node.classList.add(cls);
}

/**
 * Odometer roll from `from`→`to`, rendered as `$N` with the same decimal places
 * as the authoritative `finalText`, then snapped to `$finalText` so we never drift
 * off the server's exact value. Cancels any in-flight roll on the same node.
 */
function countUp(node: HTMLElement, from: number, to: number, finalText: string): void {
  const n = node as HTMLElement & { _cuRaf?: number };
  if (n._cuRaf) cancelAnimationFrame(n._cuRaf);
  const decimals = finalText.split('.')[1]?.length ?? 0;
  const dur = 480;
  const t0 = performance.now();
  const step = (t: number): void => {
    const p = Math.min(1, (t - t0) / dur);
    const eased = 1 - Math.pow(1 - p, 3); // easeOutCubic — fast then settles
    node.textContent = `$${(from + (to - from) * eased).toFixed(decimals)}`;
    if (p < 1) {
      n._cuRaf = requestAnimationFrame(step);
    } else {
      node.textContent = `$${finalText}`;
      n._cuRaf = undefined;
    }
  };
  n._cuRaf = requestAnimationFrame(step);
}

/** Material-style ripple emanating from the click point, self-removing. */
function spawnRipple(btn: HTMLElement, ev: MouseEvent): void {
  const r = btn.getBoundingClientRect();
  const d = Math.max(r.width, r.height);
  const ink = document.createElement('span');
  ink.className = 'ripple';
  ink.style.width = ink.style.height = `${d}px`;
  ink.style.left = `${ev.clientX - r.left - d / 2}px`;
  ink.style.top = `${ev.clientY - r.top - d / 2}px`;
  btn.append(ink);
  window.setTimeout(() => ink.remove(), 600);
}

function spawnBidBurst(btn: HTMLElement, amountText: string): void {
  const burst = document.createElement('span');
  burst.className = 'bidburst';
  burst.textContent = `+$${amountText}`;
  btn.append(burst);
  window.setTimeout(() => burst.remove(), 850);
}

interface Sparks {
  setFill(frac: number): void;
  start(): void;
  stop(): void;
  destroy(): void;
}

/**
 * A tiny additive-blend spark emitter that burns at the timer bar's leading edge
 * during the final 10s — like a lit fuse racing the clock. Particles spawn only
 * while `running`; the loop sleeps once everything has burned out (no idle cost).
 */
function makeSparks(canvas: HTMLCanvasElement): Sparks {
  const ctx = canvas.getContext('2d');
  type P = { x: number; y: number; vx: number; vy: number; g: number; life: number; s: number; c: string };
  const parts: P[] = [];
  const COLORS = ['#ffffff', '#ffe27a', '#ffb020', '#ff7a45'];
  let raf = 0;
  let running = false;
  let fill = 1;
  let w = 0;
  let h = 0;
  let dpr = 1;

  const resize = (): void => {
    dpr = Math.min(2, window.devicePixelRatio || 1);
    w = canvas.clientWidth || canvas.parentElement?.clientWidth || 0;
    h = canvas.clientHeight || 40;
    canvas.width = Math.max(1, Math.round(w * dpr));
    canvas.height = Math.max(1, Math.round(h * dpr));
  };

  const frame = (): void => {
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.globalCompositeOperation = 'lighter';
    if (running) {
      const x = Math.max(2, Math.min(w - 2, fill * w));
      const y = h - 2;
      const n = 2 + ((Math.random() * 3) | 0);
      for (let i = 0; i < n; i++) {
        parts.push({
          x,
          y,
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
      p.vy += p.g;
      p.x += p.vx;
      p.y += p.vy;
      p.life -= 0.035;
      if (p.life <= 0) continue;
      ctx.globalAlpha = Math.max(0, p.life);
      ctx.fillStyle = p.c;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.s, 0, Math.PI * 2);
      ctx.fill();
    }
    for (let i = parts.length - 1; i >= 0; i--) if (parts[i]!.life <= 0) parts.splice(i, 1);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    raf = running || parts.length ? requestAnimationFrame(frame) : 0;
  };

  return {
    setFill(frac) {
      fill = Math.max(0, Math.min(1, frac));
    },
    start() {
      if (!w) resize();
      if (!running) {
        running = true;
        if (!raf) raf = requestAnimationFrame(frame);
      }
    },
    stop() {
      running = false;
    },
    destroy() {
      running = false;
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
    },
  };
}

export function createPanel(handlers: PanelHandlers): PanelHandle {
  const root = el('div', 'panel');

  // Header
  const head = el('div', 'head');
  const brand = el('div', 'brand');
  brand.innerHTML = '<span class="b">BID</span>it';
  const live = el('div', 'live hidden');
  live.innerHTML = '<i></i>LIVE';
  const conn = el('div', 'conn');
  const dot = el('i', 'dot');
  const connText = el('span', 'conn-text', 'connecting…');
  conn.append(dot, connText);
  const grip = el('div', 'grip', '⠿'); // drag affordance — header is the grab handle
  head.append(grip, brand, live, conn);

  // Body
  const body = el('div', 'body');

  const stage = el('div', 'stage');
  const thumbWrap = el('div', 'thumb-wrap');
  const thumb = el('img', 'thumb');
  thumb.alt = '';
  thumbWrap.append(thumb);
  const info = el('div', 'info');
  const title = el('div', 'title', 'Waiting for the next item…');
  const leaderRow = el('div', 'leaderrow');
  const leaderAv = el('div', 'leader-av');
  const leaderText = el('span', 'leadertext', 'No bids yet');
  leaderRow.append(leaderAv, leaderText);
  info.append(title, leaderRow);
  stage.append(thumbWrap, info);

  const clockrow = el('div', 'clockrow');
  const bidBlock = el('div', 'block');
  const currentBidEl = el('div', 'bid', '—');
  bidBlock.append(el('div', 'label', 'Current bid'), currentBidEl);
  const timerBlock = el('div', 'block right');
  const timerEl = el('div', 'timer', '—');
  const timerLabel = el('div', 'label', 'remaining');
  timerBlock.append(timerEl, timerLabel);
  clockrow.append(bidBlock, timerBlock);

  const progressWrap = el('div', 'progresswrap');
  const progress = el('div', 'progress');
  const bar = el('div', 'bar');
  progress.append(bar);
  const sparkCanvas = el('canvas', 'sparks');
  progressWrap.append(progress, sparkCanvas);
  const sparks = makeSparks(sparkCanvas);

  // Anti-snipe flash — a transient badge that pops over the timer on extension.
  const ext = el('div', 'ext', '⏱ EXTENDED!');

  // Randomizer prize pool — a collapsible "what's on the wheel" list.
  const prizes = el('div', 'prizes hidden');
  const prizesToggle = el('button', 'prizestoggle');
  const prizesList = el('div', 'prizeslist hidden');
  prizes.append(prizesToggle, prizesList);
  prizesToggle.addEventListener('click', () => prizesList.classList.toggle('hidden'));

  const banner = el('div', 'banner');
  const feed = el('div', 'feed');

  const bidBtn = el('button', 'bidbtn');
  const shine = el('span', 'shine');
  const bidBtnLbl = el('span', 'bb-lbl', 'BID');
  const bidBtnAmt = el('span', 'bb-amt', '');
  bidBtn.append(shine, bidBtnLbl, bidBtnAmt);
  bidBtn.disabled = true;

  const customRow = el('div', 'customrow');
  const amount = el('input', 'amount') as HTMLInputElement;
  amount.type = 'number';
  amount.step = '0.01';
  amount.placeholder = 'custom amount';
  const customBtn = el('button', 'custombtn', 'Bid');
  customRow.append(amount, customBtn);

  body.append(stage, prizes, clockrow, progressWrap, ext, banner, feed, bidBtn, customRow);

  // Empty state
  const empty = el('div', 'empty hidden');
  const emptyText = el('div', 'emptytext', '');
  const seedBtn = el('button', 'seedbtn hidden', 'Start a demo auction here');
  empty.append(emptyText, seedBtn);

  // Footer
  const footer = el('div', 'footer');
  const availEl = el('b', 'avail', '—');
  footer.append(el('span', 'flabel', 'Balance'), availEl);

  root.append(head, body, empty, footer);

  // ---- local countdown state --------------------------------------------
  let myHandle: string | null = null;
  let endsAt: number | null = null;
  let serverOffset = 0;
  let lastLeader: string | null = null;
  let lastBid: string | null = null;
  let lastBidNum = 0;
  let lastMinNum = 0;
  let durationMs = 20_000;
  let closed = false;
  let lastAuctionId: string | null = null;

  const tick = (): void => {
    if (endsAt === null) return;
    const remaining = Math.max(0, endsAt - (Date.now() + serverOffset));
    timerEl.textContent = `${(remaining / 1000).toFixed(1)}s`;
    const pct = durationMs > 0 ? Math.max(0, Math.min(100, (remaining / durationMs) * 100)) : 0;
    bar.style.width = `${pct}%`;
    // <=10s: number turns red and starts a heartbeat. <=5s: the whole panel
    // catches a red glow and the heartbeat goes frantic (driven by .final in CSS).
    const red = remaining > 0 && remaining <= 10_000;
    const final = remaining > 0 && remaining <= 5_000;
    timerEl.classList.toggle('red', red);
    timerEl.classList.toggle('beat', red);
    bar.classList.toggle('red', red);
    root.classList.toggle('final', final);
    // Sparks ride the bar's leading edge — lit only in the final 10s.
    sparks.setFill(pct / 100);
    if (red) sparks.start();
    else sparks.stop();
  };
  const interval = window.setInterval(tick, 100);

  // ---- handlers ---------------------------------------------------------
  bidBtn.addEventListener('click', (ev) => {
    const a = bidBtn.dataset.amount;
    if (a) {
      spawnRipple(bidBtn, ev);
      pulse(bidBtn, 'pressed');
      handlers.onBid(a);
    }
  });
  customBtn.addEventListener('click', () => {
    const v = amount.value.trim();
    if (v) handlers.onBid(v);
  });
  seedBtn.addEventListener('click', () => handlers.onSeedDemo?.());

  // ---- drag-to-move (grab the header) -----------------------------------
  // We move the shadow *host* (the floating element), switching it from the
  // default top/right anchor to explicit left/top on first grab.
  const hostEl = (): HTMLElement | null => {
    const r = root.getRootNode();
    return r instanceof ShadowRoot ? (r.host as HTMLElement) : null;
  };
  let dragging = false;
  let startX = 0;
  let startY = 0;
  let baseLeft = 0;
  let baseTop = 0;
  head.addEventListener('pointerdown', (ev) => {
    const host = hostEl();
    if (!host) return;
    dragging = true;
    head.classList.add('grabbing');
    const rect = host.getBoundingClientRect();
    baseLeft = rect.left;
    baseTop = rect.top;
    startX = ev.clientX;
    startY = ev.clientY;
    host.style.left = `${baseLeft}px`;
    host.style.top = `${baseTop}px`;
    host.style.right = 'auto';
    host.style.bottom = 'auto';
    head.setPointerCapture(ev.pointerId);
    ev.preventDefault();
  });
  head.addEventListener('pointermove', (ev) => {
    if (!dragging) return;
    const host = hostEl();
    if (!host) return;
    const maxLeft = window.innerWidth - host.offsetWidth - 4;
    const maxTop = window.innerHeight - 44; // keep the grab handle reachable
    host.style.left = `${Math.max(4, Math.min(maxLeft, baseLeft + ev.clientX - startX))}px`;
    host.style.top = `${Math.max(4, Math.min(maxTop, baseTop + ev.clientY - startY))}px`;
  });
  const endDrag = (ev: PointerEvent): void => {
    if (!dragging) return;
    dragging = false;
    head.classList.remove('grabbing');
    try {
      head.releasePointerCapture(ev.pointerId);
    } catch {
      /* pointer already released */
    }
  };
  head.addEventListener('pointerup', endDrag);
  head.addEventListener('pointercancel', endDrag);

  const setStatus = (text: string, kind: StatusKind = 'info'): void => {
    banner.textContent = text;
    banner.className = `banner show ${kind}`;
    if (kind === 'outbid' || kind === 'error') pulse(banner, 'shake');
  };
  const clearStatus = (): void => {
    banner.className = 'banner';
    banner.textContent = '';
  };
  const showBody = (show: boolean): void => {
    body.classList.toggle('hidden', !show);
    empty.classList.toggle('hidden', show);
  };

  return {
    root,
    setConnected(connected, handle) {
      myHandle = handle;
      dot.className = `dot ${connected ? 'on' : 'off'}`;
      connText.textContent = connected ? (handle ?? 'connected') : 'connecting…';
    },
    setBalance(available) {
      availEl.textContent = available !== null ? `$${available}` : '—';
    },
    applyState(s) {
      // After a win the server echoes a final SETTLING state; ignore it so the
      // celebratory "you won" panel isn't clobbered by a dull settling screen.
      if (s.status === 'RUNNING') closed = false;
      else if (closed) return;
      // New item → drop the previous item's bid feed so old bids don't linger.
      if (s.auctionId !== lastAuctionId) {
        lastAuctionId = s.auctionId;
        feed.replaceChildren();
        prizesList.classList.add('hidden');
      }
      // Randomizer: let bidders see what's on the wheel (label + quantity).
      const wheel = s.wheel ?? [];
      if (wheel.length > 0) {
        prizes.classList.remove('hidden');
        prizesToggle.textContent = `🎡 ${wheel.length} prizes on the wheel`;
        if (prizesList.dataset.for !== s.auctionId) {
          prizesList.dataset.for = s.auctionId;
          prizesList.replaceChildren();
          for (const p of wheel) {
            const row = el('div', 'prizerow');
            const name = el('span', 'prizename');
            name.textContent = p.label;
            const qty = el('span', 'prizeqty');
            qty.textContent = `×${p.weight ?? 1}`;
            row.append(name, qty);
            prizesList.append(row);
          }
        }
      } else {
        prizes.classList.add('hidden');
      }
      showBody(true);
      const running = s.status === 'RUNNING';
      live.classList.toggle('hidden', !running);
      title.textContent = s.title;
      if (s.imageUrl) {
        thumb.src = s.imageUrl;
        thumb.style.visibility = 'visible';
      } else {
        thumb.removeAttribute('src');
      }

      if (s.currentBid) {
        const toNum = parseFloat(s.currentBid);
        if (s.currentBid !== lastBid) {
          pulse(currentBidEl, 'bump');
          if (toNum > lastBidNum) countUp(currentBidEl, lastBidNum, toNum, s.currentBid);
          else currentBidEl.textContent = `$${s.currentBid}`;
        }
        lastBidNum = toNum;
      } else {
        currentBidEl.textContent = '—';
        lastBidNum = 0;
      }
      lastBid = s.currentBid;

      const leadingMe = s.leaderHandle !== null && s.leaderHandle === myHandle;
      leaderRow.classList.toggle('leading', leadingMe);
      // You just seized the lead -> a satisfying burst on the bid button.
      if (leadingMe && lastLeader !== myHandle) pulse(bidBtn, 'win');
      leaderAv.replaceChildren();
      if (s.leaderHandle) leaderAv.append(makeAvatar(s.leaderHandle, 20));
      leaderText.textContent = leadingMe
        ? "You're winning 🔥"
        : s.leaderHandle
          ? `${s.leaderHandle} is winning`
          : 'No bids yet — take the lead';

      if (leadingMe) {
        setStatus("You're winning 🔥", 'leading');
      } else if (lastLeader === myHandle && myHandle !== null && s.leaderHandle !== null) {
        setStatus('Outbid! Bid again', 'outbid');
      } else {
        clearStatus();
      }
      lastLeader = s.leaderHandle;

      bidBtn.dataset.amount = s.minNextBid;
      if (running) {
        bidBtnLbl.textContent = 'BID';
        const toMin = parseFloat(s.minNextBid);
        if (lastMinNum > 0 && toMin !== lastMinNum) countUp(bidBtnAmt, lastMinNum, toMin, s.minNextBid);
        else bidBtnAmt.textContent = `$${s.minNextBid}`;
        lastMinNum = toMin;
      } else {
        bidBtnLbl.textContent =
          s.status === 'SETTLING' ? 'SOLD ✓' : s.status === 'CLOSED' ? 'Auction ended' : 'Auction over';
        bidBtnAmt.textContent = '';
      }
      bidBtn.disabled = !running;
      customBtn.disabled = !running;
      amount.disabled = !running;
      if (document.activeElement !== amount) amount.value = s.minNextBid;

      durationMs = s.durationSeconds * 1000;
      endsAt = s.endsAt;
      serverOffset = s.serverNow - Date.now();
      tick();
    },
    applyClosed(c) {
      closed = true;
      live.classList.add('hidden');
      endsAt = null;
      sparks.stop();
      timerEl.textContent = 'ENDED';
      timerEl.classList.remove('red', 'beat');
      root.classList.remove('final');
      bar.classList.remove('red');
      bar.style.width = '0%';
      bidBtn.disabled = true;
      customBtn.disabled = true;
      amount.disabled = true;
      const won = c.winnerHandle === myHandle && myHandle !== null;
      setStatus(
        c.winnerHandle ? (won ? `You won for $${c.amount}! 🎉` : `Sold to ${c.winnerHandle} · $${c.amount}`) : 'Ended — no sale',
        won ? 'leading' : 'info',
      );
    },
    applyRejected(r) {
      const [text, kind] = REJECT_TEXT[r.reason] ?? [r.reason, 'error'];
      setStatus(text, kind);
    },
    pushBid(handle, amount) {
      const rowEl = el('div', 'feedrow');
      rowEl.append(makeAvatar(handle, 18));
      const txt = el('span', 'feedtext');
      const who = el('b');
      who.textContent = handle;
      const amt = el('b', 'amt');
      amt.textContent = `$${amount}`;
      txt.append(who, document.createTextNode(' bid '), amt);
      rowEl.append(txt);
      feed.prepend(rowEl);
      while (feed.children.length > 3) feed.lastElementChild?.remove();
      pulse(rowEl, 'in');
    },
    showBidBurst(amount) {
      spawnBidBurst(bidBtn, amount);
      pulse(bidBtn, 'win');
    },
    flashExtended() {
      pulse(ext, 'show');
      pulse(bar, 'refill');
    },
    setStatus,
    setNoAuction(linked) {
      showBody(false);
      live.classList.add('hidden');
      emptyText.textContent = linked
        ? 'Waiting for the seller to start an auction…'
        : 'No BIDit auctions on this coin yet.';
      seedBtn.classList.toggle('hidden', linked || !handlers.onSeedDemo);
    },
    destroy() {
      window.clearInterval(interval);
      sparks.destroy();
      root.remove();
    },
  };
}
