/**
 * Background service worker: the ONLY thing that talks to the backend.
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
/** Whether the signed-in account can bid. False when the account has an email it
 *  hasn't confirmed: the server rejects its bids (EMAIL_UNVERIFIED), so the UI
 *  surfaces a "verify your email" prompt instead of a dead bid button. */
let emailVerified = true;
let ws: WebSocket | null = null;
let connected = false;
let lastBalance: BalanceUpdateMessage | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;

const ready = loadAuth();

async function loadAuth(): Promise<void> {
  const got = await chrome.storage.local.get(['biditToken', 'biditHandle', 'biditUserId', 'biditEmailVerified']);
  token = (got.biditToken as string | undefined) ?? null;
  handle = (got.biditHandle as string | undefined) ?? null;
  userId = (got.biditUserId as string | undefined) ?? null;
  emailVerified = got.biditEmailVerified !== false;
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

const statusMsg = (): SwToUi => ({ evt: 'STATUS', connected, handle, emailVerified: handle ? emailVerified : true });

// ---- WebSocket -----------------------------------------------------------

let connecting = false;
let backoff = 0;

function sendWs(obj: unknown): void {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

/**
 * Mint a short-lived, single-use WS ticket. This is the backend's intended
 * handshake: it keeps the 30-day session token out of the socket URL (and out of
 * any proxy/access logs). A 401/403 means the stored session is dead (expired, or
 * revoked by a web logout / ban / data-erasure), so we sign the user out rather
 * than reconnect forever against a token that will never work again.
 */
async function mintTicket(): Promise<string | null> {
  if (!token) return null;
  try {
    const res = await fetch(`${BACKEND_HTTP}/realtime/ticket`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: '{}',
    });
    if (res.status === 401 || res.status === 403) {
      handleSessionExpired();
      return null;
    }
    if (!res.ok) return null; // transient (5xx): caller retries with backoff
    const data = (await res.json().catch(() => null)) as { ticket?: unknown } | null;
    return typeof data?.ticket === 'string' ? data.ticket : null;
  } catch {
    return null; // offline / server asleep: caller retries
  }
}

async function connectWs(): Promise<void> {
  if (!token || connecting) return;
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  connecting = true;
  const ticket = await mintTicket();
  connecting = false;
  if (!ticket) {
    if (token) scheduleReconnect(); // still signed in but no ticket yet → retry
    return;
  }
  const sock = new WebSocket(`${BACKEND_WS}?ticket=${encodeURIComponent(ticket)}`);
  ws = sock;
  sock.addEventListener('open', () => {
    connected = true;
    backoff = 0; // healthy connection: reset the reconnect delay
    broadcast(statusMsg());
    for (const room of subscribed) sendWs({ type: 'SUBSCRIBE', room });
  });
  sock.addEventListener('message', (ev) => {
    let message: ServerMessage;
    try {
      message = JSON.parse(String(ev.data));
    } catch {
      return;
    }
    if (message.type === 'BALANCE_UPDATE') lastBalance = message;
    broadcast({ evt: 'SERVER', message });
  });
  sock.addEventListener('close', (ev) => {
    connected = false;
    if (ws === sock) ws = null;
    broadcast(statusMsg());
    // 4001 = unauthorized / unknown user / session revoked (server-side close).
    // Any other code is a transient drop (SW nap, network) → reconnect.
    if (ev.code === 4001) handleSessionExpired();
    else if (token) scheduleReconnect();
  });
  sock.addEventListener('error', () => {
    try {
      sock.close();
    } catch {
      /* noop */
    }
  });
}

function scheduleReconnect(): void {
  if (reconnectTimer || !token) return;
  // Exponential backoff (1.5s → ~15s) so a sleeping Render dyno or a flaky
  // network isn't hammered; reset to 0 on a successful open.
  const delay = Math.min(15_000, 1_500 * Math.pow(1.7, backoff));
  backoff = Math.min(backoff + 1, 6);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = undefined;
    void connectWs();
  }, delay);
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

/**
 * The stored session is no longer usable (30-day token expired, or revoked by a
 * web logout / ban / erasure). Clear it and tell the UI to prompt a fresh sign-in
 * instead of looping reconnects against a dead token.
 */
function handleSessionExpired(): void {
  const wasSignedIn = token !== null;
  token = null;
  handle = null;
  userId = null;
  lastBalance = null;
  subscribed.clear();
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = undefined;
  }
  void chrome.storage.local.remove(['biditToken', 'biditHandle', 'biditUserId']);
  closeWs();
  if (wasSignedIn) broadcast({ evt: 'AUTH_ERROR', message: 'Your session expired. Please sign in again.' });
  broadcast(statusMsg());
}

function ensureSubscribed(room: string): void {
  subscribed.add(room);
  if (ws && ws.readyState === WebSocket.OPEN) sendWs({ type: 'SUBSCRIBE', room });
  else void connectWs();
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
    void connectWs();
  }
}
setInterval(resync, 12_000);

// ---- REST ----------------------------------------------------------------

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

/** Real email/password login, same account as the BIDit website, so the
 *  extension bids from the same deposited balance. Surfaces the server's actual
 *  error (rate limit, suspended, unverified) rather than a blanket "wrong
 *  password", and remembers whether the email is verified so the UI can prompt. */
async function handleEmailLogin(email: string, password: string): Promise<void> {
  let res: Response;
  try {
    res = await fetch(`${BACKEND_HTTP}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
  } catch {
    broadcast({ evt: 'AUTH_ERROR', message: 'Can’t reach BIDit right now. Check your connection.' });
    return;
  }
  const data = (await res.json().catch(() => null)) as
    | { token?: string; handle?: string; userId?: string; emailVerified?: boolean; error?: string }
    | null;
  if (!res.ok || !data?.token) {
    const msg =
      res.status === 429
        ? 'Too many attempts. Wait a minute and try again.'
        : res.status === 403
          ? (data?.error ?? 'This account isn’t available.')
          : (data?.error ?? 'Wrong email or password.');
    broadcast({ evt: 'AUTH_ERROR', message: msg });
    return;
  }
  token = data.token;
  handle = data.handle ?? null;
  userId = data.userId ?? null;
  emailVerified = data.emailVerified !== false;
  backoff = 0;
  await chrome.storage.local.set({
    biditToken: token,
    biditHandle: handle,
    biditUserId: userId,
    biditEmailVerified: emailVerified,
  });
  closeWs();
  void connectWs();
  broadcast(statusMsg());
}

/** Used by the popup's wallet sign-in: it does the signing and hands us a session.
 *  Wallet accounts have no email, so they're never gated on verification. */
async function handleSetSession(t: string, h: string, uid: string): Promise<void> {
  token = t;
  handle = h;
  userId = uid;
  emailVerified = true;
  backoff = 0;
  await chrome.storage.local.set({
    biditToken: token,
    biditHandle: handle,
    biditUserId: userId,
    biditEmailVerified: true,
  });
  closeWs();
  void connectWs();
  broadcast(statusMsg());
}

async function handleLogout(): Promise<void> {
  token = null;
  handle = null;
  userId = null;
  emailVerified = true;
  lastBalance = null;
  backoff = 0;
  await chrome.storage.local.remove(['biditToken', 'biditHandle', 'biditUserId', 'biditEmailVerified']);
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
    if (token && !connected) void connectWs();
  });
  port.onMessage.addListener((m: UiToSw) => void handleUi(m, port));
  port.onDisconnect.addListener(() => ports.delete(port));
});
