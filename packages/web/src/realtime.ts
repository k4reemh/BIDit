import { API } from './config';
import { getToken } from './api';

/** Trade the bearer session for a one-time, short-lived WebSocket ticket, so the
 *  long-lived token never goes in the socket URL. Returns null if signed out or
 *  the mint fails (caller retries). */
async function mintWsTicket(): Promise<string | null> {
  const token = getToken();
  if (!token) return null;
  try {
    const r = await fetch(`${API}/realtime/ticket`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
    });
    if (!r.ok) return null;
    const { ticket } = (await r.json()) as { ticket?: string };
    return typeof ticket === 'string' ? ticket : null;
  } catch {
    return null;
  }
}

export interface Balance {
  available: string;
  settled: string;
}

export interface WheelPrize {
  label: string;
  weight?: number;
  tier?: string;
  imageUrl?: string;
}
export interface AuctionState {
  auctionId: string;
  listingId?: string;
  title: string;
  imageUrl: string | null;
  status: string;
  currentBid: string | null;
  leaderHandle: string | null;
  minNextBid: string;
  durationSeconds: number;
  endsAt: number | null;
  wheel?: WheelPrize[];
  serverNow: number;
}

export interface BidAccepted {
  amount: string;
  leaderHandle: string;
  extended: boolean;
  endsAt: number | null;
  serverNow: number;
}

export interface AuctionClosed {
  auctionId: string;
  winnerHandle: string | null;
  amount: string | null;
  wheel?: boolean;
  /** Catch-up replay for a client that missed the live close — sync the result
   *  quietly (no full-screen celebration). */
  replay?: boolean;
  serverNow: number;
}

export interface GiveawayEntrant {
  userId: string;
  handle: string;
}
export interface GiveawayOpen {
  giveawayId: string;
  kind: 'PUBLIC' | 'BUYER_ONLY';
  prize: string;
  image?: string | null;
  sellerHandle: string;
  opensAt: number;
  closesAt: number;
  entrantCount: number;
  seedHash: string;
  serverNow: number;
}
export interface GiveawayEntries {
  giveawayId: string;
  count: number;
  recent: GiveawayEntrant[];
  serverNow: number;
}
export interface ReelSlot {
  label: string;
  tier?: string;
  imageUrl?: string;
}
export interface RandomizerSpin {
  auctionId: string;
  winnerHandle: string;
  amount: string;
  reel: ReelSlot[];
  targetIndex: number;
  durationMs: number;
  startsAt: number;
  seedHash: string;
  serverNow: number;
}
export interface GiveawayWinner {
  giveawayId: string;
  kind: 'PUBLIC' | 'BUYER_ONLY';
  prize: string;
  image?: string | null;
  winnerHandle: string;
  winnerUserId: string;
  entrantCount: number;
  roll: GiveawayEntrant[];
  targetIndex: number;
  durationMs: number;
  startsAt: number;
  seed: string;
  seedHash: string;
  serverNow: number;
}

export interface ChatLine {
  id: string;
  senderId: string;
  handle: string;
  text: string;
  createdAt: number;
}

interface Handlers {
  onBalance?: (b: Balance) => void;
  room?: string;
  onState?: (m: AuctionState) => void;
  onBid?: (m: BidAccepted) => void;
  onClosed?: (m: AuctionClosed) => void;
  onGiveawayOpen?: (m: GiveawayOpen) => void;
  onGiveawayEntries?: (m: GiveawayEntries) => void;
  onGiveawayWinner?: (m: GiveawayWinner) => void;
  onGiveawayRejected?: (m: { giveawayId: string; reason: string }) => void;
  onBidRejected?: (m: { auctionId: string; reason: string }) => void;
  onSpin?: (m: RandomizerSpin) => void;
  onChat?: (m: ChatLine) => void;
  onChatHistory?: (messages: ChatLine[]) => void;
  onChatDeleted?: (messageId: string) => void;
  onChatRejected?: (m: { reason: string; retryMs?: number }) => void;
}

/**
 * One authenticated WebSocket to the realtime server. Always streams the user's
 * live balance; if `room` is set it also SUBSCRIBEs and dispatches that room's
 * auction state / bids / close. Auto-reconnects; returns a disposer.
 */
export function openSocket(h: Handlers): () => void {
  const wsBase = API.replace(/^http/, 'ws');
  let ws: WebSocket | null = null;
  let closed = false;
  let retry: ReturnType<typeof setTimeout> | null = null;

  const open = async () => {
    if (closed) return;
    const ticket = await mintWsTicket();
    if (!ticket || closed) {
      if (!closed) retry = setTimeout(open, 2500); // no ticket yet (signed out / offline) — retry
      return;
    }
    ws = new WebSocket(`${wsBase}/ws?ticket=${encodeURIComponent(ticket)}`);
    ws.onopen = () => {
      if (h.room) ws?.send(JSON.stringify({ type: 'SUBSCRIBE', room: h.room }));
    };
    ws.onmessage = (ev) => dispatch(h, String(ev.data));
    ws.onclose = () => {
      ws = null;
      if (!closed) retry = setTimeout(open, 2500);
    };
    ws.onerror = () => {
      try {
        ws?.close();
      } catch {
        /* noop */
      }
    };
  };
  open();

  return () => {
    closed = true;
    if (retry) clearTimeout(retry);
    try {
      ws?.close();
    } catch {
      /* noop */
    }
  };
}

export const connectBalance = (onBalance: (b: Balance) => void) => openSocket({ onBalance });

function dispatch(h: Handlers, raw: string): void {
  let m: { type?: string } & Record<string, unknown>;
  try {
    m = JSON.parse(raw);
  } catch {
    return;
  }
  switch (m.type) {
    case 'BALANCE_UPDATE':
      h.onBalance?.({ available: m.available as string, settled: m.settled as string });
      break;
    case 'AUCTION_STATE':
      h.onState?.(m as unknown as AuctionState);
      break;
    case 'BID_ACCEPTED':
      h.onBid?.(m as unknown as BidAccepted);
      break;
    case 'AUCTION_CLOSED':
      h.onClosed?.(m as unknown as AuctionClosed);
      break;
    case 'GIVEAWAY_OPEN':
      h.onGiveawayOpen?.(m as unknown as GiveawayOpen);
      break;
    case 'GIVEAWAY_ENTRIES':
      h.onGiveawayEntries?.(m as unknown as GiveawayEntries);
      break;
    case 'GIVEAWAY_WINNER':
      h.onGiveawayWinner?.(m as unknown as GiveawayWinner);
      break;
    case 'RANDOMIZER_SPIN':
      h.onSpin?.(m as unknown as RandomizerSpin);
      break;
    case 'GIVEAWAY_REJECTED':
      h.onGiveawayRejected?.(m as unknown as { giveawayId: string; reason: string });
      break;
    case 'BID_REJECTED':
      h.onBidRejected?.(m as unknown as { auctionId: string; reason: string });
      break;
    case 'CHAT_MESSAGE':
      h.onChat?.((m as unknown as { line: ChatLine }).line);
      break;
    case 'CHAT_HISTORY':
      h.onChatHistory?.((m as unknown as { messages: ChatLine[] }).messages);
      break;
    case 'CHAT_DELETED':
      h.onChatDeleted?.(m.messageId as string);
      break;
    case 'CHAT_REJECTED':
      h.onChatRejected?.({ reason: m.reason as string, retryMs: m.retryMs as number | undefined });
      break;
  }
}

export interface RoomController {
  close: () => void;
  bid: (auctionId: string, amount: string) => void;
  enterGiveaway: (giveawayId: string) => void;
  /** Post a chat message to the room. */
  sendChat: (text: string) => void;
  /** Seller-only: delete a message / block a user in their own room. */
  deleteChat: (messageId: string) => void;
  blockUser: (userId: string) => void;
  /** Force a re-subscribe to pull fresh state — used to recover a frozen timer
   *  if a close broadcast was missed. */
  resync: () => void;
}

/**
 * Like openSocket but for a specific seller's room, and it can SEND — place bids
 * (BID_INTENT) and enter giveaways (GIVEAWAY_ENTER). Powers the in-site watch page
 * so a viewer can bid without the extension. Requires the viewer to be signed in
 * (the server gates the socket on a token); returns a controller.
 */
export function openRoom(room: string, h: Omit<Handlers, 'room'>): RoomController {
  const wsBase = API.replace(/^http/, 'ws');
  let ws: WebSocket | null = null;
  let closed = false;
  let retry: ReturnType<typeof setTimeout> | null = null;

  const send = (obj: unknown) => {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  };
  // Re-SUBSCRIBE is idempotent server-side and replays the current running
  // auction, so this recovers if a broadcast was missed (e.g. a dropped socket)
  // without needing a page refresh.
  const resync = () => send({ type: 'SUBSCRIBE', room });

  const open = async () => {
    if (closed) return; // signed-out viewers can't open the socket
    const ticket = await mintWsTicket();
    if (!ticket || closed) {
      if (!closed) retry = setTimeout(open, 2500);
      return;
    }
    ws = new WebSocket(`${wsBase}/ws?ticket=${encodeURIComponent(ticket)}`);
    ws.onopen = () => resync();
    ws.onmessage = (ev) => dispatch(h, String(ev.data));
    ws.onclose = () => {
      ws = null;
      if (!closed) retry = setTimeout(open, 2500);
    };
    ws.onerror = () => {
      try {
        ws?.close();
      } catch {
        /* noop */
      }
    };
  };
  open();

  // Heartbeat re-sync + re-sync when the tab is refocused.
  const beat = setInterval(() => {
    if (closed) return;
    if (ws && ws.readyState === WebSocket.OPEN) resync();
    else open();
  }, 12_000);
  const onVis = () => { if (!closed && document.visibilityState === 'visible') { if (ws && ws.readyState === WebSocket.OPEN) resync(); else open(); } };
  document.addEventListener('visibilitychange', onVis);

  return {
    close: () => {
      closed = true;
      if (retry) clearTimeout(retry);
      clearInterval(beat);
      document.removeEventListener('visibilitychange', onVis);
      try {
        ws?.close();
      } catch {
        /* noop */
      }
    },
    bid: (auctionId, amount) =>
      send({ type: 'BID_INTENT', auctionId, amount, clientNonce: Math.random().toString(36).slice(2) }),
    enterGiveaway: (giveawayId) => send({ type: 'GIVEAWAY_ENTER', giveawayId }),
    sendChat: (text) => send({ type: 'CHAT_SEND', room, text }),
    deleteChat: (messageId) => send({ type: 'CHAT_DELETE', room, messageId }),
    blockUser: (userId) => send({ type: 'CHAT_BLOCK', room, userId }),
    resync: () => { if (ws && ws.readyState === WebSocket.OPEN) resync(); else open(); },
  };
}
