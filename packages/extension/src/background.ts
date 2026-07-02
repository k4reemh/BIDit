/**
 * Background service worker — the ONLY thing that talks to the backend.
 * Owns the WebSocket + REST calls (so they aren't subject to Pump.fun's page
 * CSP) and relays authoritative server messages to every connected UI port
 * (content scripts + popup). It validates nothing and does no money math.
 */
import { BACKEND_HTTP, BACKEND_WS } from './config.js';
import { PORT_NAME, type SwToUi, type UiToSw } from './messages.js';
import type { ServerMessage, BalanceUpdateMessage } from '@bidit/shared';

const ports = new Set<chrome.runtime.Port>();
const subscribed = new Set<string>(); // rooms we've asked the server to join
let token: string | null = null;
let handle: string | null = null;
let userId: string | null = null;
let ws: WebSocket | null = null;
let connected = false;
let lastBalance: BalanceUpdateMessage | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;

const ready = loadAuth();

async function loadAuth(): Promise<void> {
  const got = await chrome.storage.local.get(['biditToken', 'biditHandle', 'biditUserId']);
  token = (got.biditToken as string | undefined) ?? null;
  handle = (got.biditHandle as string | undefined) ?? null;
  userId = (got.biditUserId as string | undefined) ?? null;
}

function broadcast(msg: SwToUi): void {
  for (const port of ports) {
    try {
      port.postMessage(msg);
    } catch {
      /* port closed */
    }
  }
}

const statusMsg = (): SwToUi => ({ evt: 'STATUS', connected, handle });

// ---- WebSocket -----------------------------------------------------------

function sendWs(obj: unknown): void {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function connectWs(): void {
  if (!token) return;
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  ws = new WebSocket(`${BACKEND_WS}?token=${encodeURIComponent(token)}`);
  ws.addEventListener('open', () => {
    connected = true;
    broadcast(statusMsg());
    for (const room of subscribed) sendWs({ type: 'SUBSCRIBE', room });
  });
  ws.addEventListener('message', (ev) => {
    let message: ServerMessage;
    try {
      message = JSON.parse(String(ev.data));
    } catch {
      return;
    }
    if (message.type === 'BALANCE_UPDATE') lastBalance = message;
    broadcast({ evt: 'SERVER', message });
  });
  ws.addEventListener('close', () => {
    connected = false;
    ws = null;
    broadcast(statusMsg());
    if (token) scheduleReconnect();
  });
  ws.addEventListener('error', () => {
    try {
      ws?.close();
    } catch {
      /* noop */
    }
  });
}

function scheduleReconnect(): void {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = undefined;
    connectWs();
  }, 2000);
}

function closeWs(): void {
  if (ws) {
    try {
      ws.close();
    } catch {
      /* noop */
    }
    ws = null;
  }
  connected = false;
}

function ensureSubscribed(room: string): void {
  subscribed.add(room);
  if (ws && ws.readyState === WebSocket.OPEN) sendWs({ type: 'SUBSCRIBE', room });
  else connectWs();
}

/**
 * Re-SUBSCRIBE every room. Server-side this is idempotent and replays the current
 * running auction, so it recovers a missed AUCTION_STATE (dropped socket, the SW
 * napping) WITHOUT the user having to refresh the pump.fun page. Driven off the
 * content script's 20s keep-alive ping (below) plus a best-effort interval.
 */
function resync(): void {
  if (ws && ws.readyState === WebSocket.OPEN) {
    for (const room of subscribed) sendWs({ type: 'SUBSCRIBE', room });
  } else if (token) {
    connectWs();
  }
}
setInterval(resync, 12_000);

// ---- REST ----------------------------------------------------------------

async function postJson(path: string, body: unknown): Promise<any> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`${BACKEND_HTTP}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  return res.ok ? res.json() : null;
}

async function resolveCoin(coin: string): Promise<{ room: string; sellerHandle: string } | null> {
  try {
    const res = await fetch(`${BACKEND_HTTP}/resolve?coin=${encodeURIComponent(coin)}`);
    return res.ok ? res.json() : null;
  } catch {
    return null;
  }
}

// ---- command handlers ----------------------------------------------------

async function handleHello(coin: string): Promise<void> {
  const resolved = await resolveCoin(coin);
  if (!resolved) {
    broadcast({ evt: 'ROOM', coin, room: null });
    return;
  }
  broadcast({ evt: 'ROOM', coin, room: resolved.room, sellerHandle: resolved.sellerHandle });
  ensureSubscribed(resolved.room);
}

/** Real email/password login — same account as the BIDit website, so the
 *  extension bids from the same deposited balance. */
async function handleEmailLogin(email: string, password: string): Promise<void> {
  const data = await postJson('/auth/login', { email, password });
  if (!data || !data.token) {
    broadcast({ evt: 'AUTH_ERROR', message: 'Wrong email or password.' });
    return;
  }
  token = data.token;
  handle = data.handle;
  userId = data.userId;
  await chrome.storage.local.set({ biditToken: token, biditHandle: handle, biditUserId: userId });
  closeWs();
  connectWs();
  broadcast(statusMsg());
}

/** Used by the popup's wallet sign-in: it does the signing and hands us a session. */
async function handleSetSession(t: string, h: string, uid: string): Promise<void> {
  token = t;
  handle = h;
  userId = uid;
  await chrome.storage.local.set({ biditToken: token, biditHandle: handle, biditUserId: userId });
  closeWs();
  connectWs();
  broadcast(statusMsg());
}

async function handleLogout(): Promise<void> {
  token = null;
  handle = null;
  userId = null;
  lastBalance = null;
  await chrome.storage.local.remove(['biditToken', 'biditHandle', 'biditUserId']);
  subscribed.clear();
  closeWs();
  broadcast(statusMsg());
}

async function handleUi(msg: UiToSw, port: chrome.runtime.Port): Promise<void> {
  await ready;
  switch (msg.cmd) {
    case 'HELLO':
      await handleHello(msg.coin);
      break;
    case 'BID':
      sendWs({ type: 'BID_INTENT', auctionId: msg.auctionId, amount: msg.amount, clientNonce: msg.nonce });
      break;
    case 'GIVEAWAY_ENTER':
      sendWs({ type: 'GIVEAWAY_ENTER', giveawayId: msg.giveawayId });
      break;
    case 'EMAIL_LOGIN':
      await handleEmailLogin(msg.email, msg.password);
      break;
    case 'SET_SESSION':
      await handleSetSession(msg.token, msg.handle, msg.userId);
      break;
    case 'LOGOUT':
      await handleLogout();
      break;
    case 'PING':
      resync(); // reliable 20s heartbeat → re-subscribe → replay the live auction
      port.postMessage({ evt: 'PONG' } satisfies SwToUi);
      break;
  }
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== PORT_NAME) return;
  ports.add(port);
  void ready.then(() => {
    port.postMessage(statusMsg());
    if (lastBalance) port.postMessage({ evt: 'SERVER', message: lastBalance } satisfies SwToUi);
    if (token && !connected) connectWs();
  });
  port.onMessage.addListener((m: UiToSw) => void handleUi(m, port));
  port.onDisconnect.addListener(() => ports.delete(port));
});
