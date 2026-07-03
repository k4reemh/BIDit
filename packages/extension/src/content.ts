/**
 * Content script — runs in the Pump.fun page. Detects the coin, injects the
 * BIDit panel into an isolated shadow root floating over the page, and bridges
 * the panel to the background service worker. It does no networking itself.
 */
import { COIN_URL_RE } from './config.js';
import { PORT_NAME, type SwToUi } from './messages.js';
import { createPanel, type PanelHandle } from './panel.js';
import { showWinner } from './winner.js';
import { showWheel } from './wheel.js';
import { showGiveaway, type GiveawayHandle } from './giveaway.js';
import panelCss from './panel.css';

const HOST_ID = 'bidit-panel-host';

function coinFromUrl(): string | null {
  const m = COIN_URL_RE.exec(location.pathname);
  return m ? m[1]! : null;
}

let panel: PanelHandle | null = null;
let port: chrome.runtime.Port | null = null;
let myRoom: string | null = null;
let myHandle: string | null = null;
let currentAuctionId: string | null = null;
let currentCoin: string | null = null;
let lastTitle = '';
let lastImage: string | null = null;
let giveaway: GiveawayHandle | null = null;

function mountPanel(): PanelHandle {
  const host = document.createElement('div');
  host.id = HOST_ID;
  host.dataset.theme = 'dark'; // default before the saved choice loads (no light flash)
  const shadow = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = panelCss;
  shadow.append(style);

  const p = createPanel({
    onBid: (amount) => {
      if (!currentAuctionId) return;
      port?.postMessage({
        cmd: 'BID',
        auctionId: currentAuctionId,
        amount,
        nonce: Math.random().toString(36).slice(2),
      });
    },
  });
  shadow.append(p.root);
  document.body.append(host);

  // Fail-soft anchor logging: the panel floats (fixed position) regardless, but
  // we log whether Pump's video is where we expect, so a layout change is visible.
  const anchor = document.querySelector('video');
  console.info(`[BIDit] panel injected. video anchor: ${anchor ? 'found' : 'not found (floating fallback)'}`);
  return p;
}

function onServerMessage(message: SwToUi & { evt: 'SERVER' }): void {
  if (!panel) return;
  const m = message.message;
  switch (m.type) {
    case 'AUCTION_STATE':
      if (myRoom && m.room !== myRoom) return;
      currentAuctionId = m.auctionId;
      lastTitle = m.title;
      lastImage = m.imageUrl;
      panel.applyState(m);
      break;
    case 'BID_ACCEPTED':
      if (myRoom && m.room !== myRoom) return;
      panel.pushBid(m.leaderHandle, m.amount);
      if (m.leaderHandle === myHandle) panel.showBidBurst(m.amount);
      if (m.extended) panel.flashExtended();
      break;
    case 'AUCTION_CLOSED':
      if (myRoom && m.room !== myRoom) return;
      panel.applyClosed(m);
      // A wheel auction defers its celebration to the spin (RANDOMIZER_SPIN);
      // don't double-reveal here.
      if (!m.wheel && m.winnerHandle && m.amount) {
        showWinner({
          winnerHandle: m.winnerHandle,
          amount: m.amount,
          title: lastTitle || 'this item',
          imageUrl: lastImage,
          isMe: m.winnerHandle === myHandle,
        });
      }
      break;
    case 'RANDOMIZER_SPIN':
      if (myRoom && m.room !== myRoom) return;
      showWheel({
        reel: m.reel,
        targetIndex: m.targetIndex,
        durationMs: m.durationMs,
        startsAt: m.startsAt,
        serverNow: m.serverNow,
        winnerHandle: m.winnerHandle,
        amount: m.amount,
        seedHash: m.seedHash,
        isMe: m.winnerHandle === myHandle,
        onLand: (prize) => {
          showWinner({
            winnerHandle: m.winnerHandle,
            amount: m.amount,
            title: prize.label,
            imageUrl: lastImage,
            isMe: m.winnerHandle === myHandle,
          });
        },
      });
      break;
    case 'GIVEAWAY_OPEN':
      if (myRoom && m.room !== myRoom) return;
      giveaway?.close();
      giveaway = showGiveaway({
        giveawayId: m.giveawayId,
        kind: m.kind,
        prize: m.prize,
        sellerHandle: m.sellerHandle,
        opensAt: m.opensAt,
        closesAt: m.closesAt,
        serverNow: m.serverNow,
        entrantCount: m.entrantCount,
        eligible: true, // server enforces BUYER_ONLY; a reject flips the button
        onEnter: () => {
          port?.postMessage({ cmd: 'GIVEAWAY_ENTER', giveawayId: m.giveawayId });
          giveaway?.markEntered();
        },
      });
      break;
    case 'GIVEAWAY_ENTRIES':
      if (giveaway && giveaway.giveawayId === m.giveawayId) giveaway.updateEntries(m.count, m.recent);
      break;
    case 'GIVEAWAY_REJECTED':
      if (giveaway && giveaway.giveawayId === m.giveawayId) giveaway.markRejected(m.reason);
      break;
    case 'GIVEAWAY_WINNER':
      if (myRoom && m.room !== myRoom) return;
      if (giveaway && giveaway.giveawayId === m.giveawayId) {
        giveaway.reveal({
          prize: m.prize,
          winnerHandle: m.winnerHandle,
          roll: m.roll,
          targetIndex: m.targetIndex,
          durationMs: m.durationMs,
          startsAt: m.startsAt,
          serverNow: m.serverNow,
          seedHash: m.seedHash,
          isMe: m.winnerHandle === myHandle,
        });
      }
      break;
    case 'BID_REJECTED':
      panel.applyRejected(m);
      break;
    case 'BALANCE_UPDATE':
      panel.setBalance(m.available, m.settled);
      break;
  }
}

function connect(coin: string): void {
  port = chrome.runtime.connect({ name: PORT_NAME });
  port.onMessage.addListener((msg: SwToUi) => {
    switch (msg.evt) {
      case 'STATUS':
        myHandle = msg.handle;
        panel?.setConnected(msg.connected, msg.handle);
        break;
      case 'ROOM':
        if (msg.coin !== coin) return;
        myRoom = msg.room;
        if (msg.room === null) panel?.setNoAuction(false);
        else panel?.setNoAuction(true); // shows "waiting" until an AUCTION_STATE lands
        break;
      case 'SERVER':
        onServerMessage(msg);
        break;
    }
  });
  port.onDisconnect.addListener(() => {
    port = null;
    // The service worker was suspended; reconnect and re-announce.
    setTimeout(() => {
      if (currentCoin) connect(currentCoin);
    }, 500);
  });
  port.postMessage({ cmd: 'HELLO', coin });

  // Keep-alive: port traffic stops Chrome from suspending the SW mid-auction.
  window.setInterval(() => port?.postMessage({ cmd: 'PING' }), 20_000);
}

function init(): void {
  const coin = coinFromUrl();
  if (!coin) return; // not a coin page
  if (document.getElementById(HOST_ID)) return; // already injected
  currentCoin = coin;
  panel = mountPanel();
  connect(coin);

  // Pump.fun is an SPA — watch for coin changes without a full reload.
  let lastHref = location.href;
  window.setInterval(() => {
    if (location.href === lastHref) return;
    lastHref = location.href;
    const next = coinFromUrl();
    if (next && next !== currentCoin) {
      currentCoin = next;
      myRoom = null;
      currentAuctionId = null;
      port?.postMessage({ cmd: 'HELLO', coin: next });
    }
  }, 1000);
}

init();
