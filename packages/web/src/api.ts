import { API } from './config';

const TOKEN_KEY = 'bidit_token';

export interface ShippingAddress {
  name: string;
  line1: string;
  line2?: string;
  city: string;
  region: string;
  postal: string;
  country: string;
}

export interface ShippingSettings {
  originCountry: string | null;
  originRegion: string | null;
  originCity: string | null;
  originPostal: string | null;
  weeklyBundling: boolean;
  shipLater: boolean;
  privateShipping: boolean;
}

export interface Session {
  token: string;
  userId: string;
  handle: string;
  email: string | null;
  displayName: string | null;
  avatarUrl: string | null;
  bio: string | null;
  shippingAddress: ShippingAddress | null;
  bundleShipping?: boolean;
  depositAddress: string | null;
  cluster?: 'mock' | 'devnet' | 'mainnet-beta';
  interests: string[];
  onboarded: boolean;
  role: string;
  verified: boolean;
  pumpCoinAddress: string | null;
  shipping?: ShippingSettings;
  available: string;
  settled: string;
}

export const getToken = () => localStorage.getItem(TOKEN_KEY);
export const setToken = (t: string) => localStorage.setItem(TOKEN_KEY, t);
export const clearToken = () => localStorage.removeItem(TOKEN_KEY);

async function req<T>(path: string, opts: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = { 'content-type': 'application/json', ...(opts.headers as Record<string, string>) };
  const t = getToken();
  if (t) headers.authorization = `Bearer ${t}`;
  const r = await fetch(`${API}${path}`, { ...opts, headers });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((data as { error?: string }).error || 'Something went wrong. Try again.');
  return data as T;
}

export async function register(email: string, password: string): Promise<Session> {
  const s = await req<Session>('/auth/register', { method: 'POST', body: JSON.stringify({ email, password }) });
  setToken(s.token);
  return s;
}

export async function login(email: string, password: string): Promise<Session> {
  const s = await req<Session>('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) });
  setToken(s.token);
  return s;
}

export async function updateMe(patch: {
  displayName?: string;
  avatarUrl?: string;
  bio?: string;
  shippingAddress?: ShippingAddress | null;
  bundleShipping?: boolean;
}): Promise<Session> {
  return req<Session>('/me', { method: 'PATCH', body: JSON.stringify(patch) });
}

export async function completeOnboarding(payload: {
  handle?: string;
  displayName?: string;
  interests?: string[];
}): Promise<Session> {
  const s = await req<Session>('/me/onboarding', { method: 'POST', body: JSON.stringify(payload) });
  if (s.token) setToken(s.token);
  return s;
}

// ---- seller ----------------------------------------------------------------
export interface WheelEntryInput {
  label: string;
  tier?: string;
  weight?: number;
  imageUrl?: string;
}
export interface SellerListing {
  id: string;
  title: string;
  startingBid: string;
  status: string;
  quantity: number;
  imageUrl: string | null;
  wheel: WheelEntryInput[] | null;
}
export interface SellerOrder {
  id: string;
  status: string;
  amount: string;
  sellerProceeds: string;
  platformFee: string;
  buyer: string;
  title: string;
  image: string | null;
  trackingNumber: string | null;
  createdAt: number;
}

export const applySeller = () => req<Session>('/seller/apply', { method: 'POST', body: '{}' });
export const getListings = () => req<SellerListing[]>('/seller/listings');
export const getSellerOrders = () => req<SellerOrder[]>('/seller/orders');

export const createListing = (body: {
  title: string;
  imageUrl?: string;
  startingBid: string;
  quantity?: number;
  weightGrams?: number;
}) => req<SellerListing>('/seller/listings', { method: 'POST', body: JSON.stringify(body) });

export const saveShippingSettings = (s: ShippingSettings) =>
  req<Session>('/seller/shipping-settings', { method: 'POST', body: JSON.stringify(s) });

export const setWheel = (listingId: string, entries: WheelEntryInput[]) =>
  req<{ ok: boolean; count: number }>('/seller/listing/wheel', {
    method: 'POST',
    body: JSON.stringify({ listingId, entries }),
  });

export const startAuction = (listingId: string, durationSeconds: number) =>
  req<{ auctionId: string; room: string }>('/seller/start-auction', {
    method: 'POST',
    body: JSON.stringify({ listingId, durationSeconds, counterBidSeconds: 10 }),
  });

export const shipOrder = (orderId: string, trackingNumber?: string) =>
  req('/seller/order/ship', { method: 'POST', body: JSON.stringify({ orderId, trackingNumber }) });
export const deliverOrder = (orderId: string) =>
  req('/seller/order/deliver', { method: 'POST', body: JSON.stringify({ orderId }) });
export const setSellerCoin = (coinAddress: string) =>
  req<{ ok: boolean }>('/seller/coin', { method: 'POST', body: JSON.stringify({ coinAddress }) });

// ---- giveaways -------------------------------------------------------------
export type GiveawayKind = 'PUBLIC' | 'BUYER_ONLY';
export interface Giveaway {
  id: string;
  kind: GiveawayKind;
  prize: string;
  image: string | null;
  status: string;
  seedHash: string;
  opensAt: number;
  closesAt: number;
}
export const openGiveaway = (body: { kind: GiveawayKind; prize: string; image?: string | null; durationSeconds: number }) =>
  req<Giveaway>('/seller/giveaway', { method: 'POST', body: JSON.stringify(body) });
export const getGiveaway = () => req<Giveaway | null>('/seller/giveaway');
export const drawGiveaway = (giveawayId: string) =>
  req<{ ok: boolean; winnerHandle: string; entrantCount: number }>('/seller/giveaway/draw', {
    method: 'POST',
    body: JSON.stringify({ giveawayId }),
  });

// ---- live / watch page -----------------------------------------------------
export interface LiveCoin {
  coin: string;
  sellerHandle: string;
  room: string;
  hasAuction: boolean;
  hasGiveaway: boolean;
  streamLive: boolean;
  coinName: string | null;
  title: string | null;
  image: string | null;
  currentBid: string | null;
  prize: string | null;
}
export interface PumpCoin {
  name: string | null;
  symbol: string | null;
  image: string | null;
  description: string | null;
  isLive: boolean;
  unavailable?: boolean;
}
export interface ResolvedRoom {
  room: string;
  sellerHandle: string;
}
export const getLive = () => req<LiveCoin[]>('/live');
export const getPumpCoin = (mint: string) => req<PumpCoin>(`/pump/coin?mint=${encodeURIComponent(mint)}`);
/** Resolve a coin -> seller room. Returns null if no seller has linked it (404). */
export async function resolveCoin(coin: string): Promise<ResolvedRoom | null> {
  try {
    return await req<ResolvedRoom>(`/resolve?coin=${encodeURIComponent(coin)}`);
  } catch {
    return null;
  }
}

// ---- fulfillment / shipping ------------------------------------------------
export interface FulfillmentItem {
  id: string;
  title: string;
  image: string | null;
  weightGrams: number | null;
  amount: string;
  sellerId: string;
  status: string;
  heldUntil: number | null;
}
export interface ShipmentItem {
  id: string;
  title: string;
  image: string | null;
  amount: string;
}
export interface Shipment {
  id: string;
  mode: string;
  status: string;
  shippingFee: string;
  privacyFee: string;
  trackingNumber: string | null;
  carrier: string | null;
  shipTo: unknown;
  sellerHandle: string | null;
  buyerHandle: string | null;
  createdAt: number;
  shippedAt: number | null;
  items: ShipmentItem[];
}
export interface Fulfillment {
  items: FulfillmentItem[];
  shipments: Shipment[];
}

export const getFulfillment = () => req<Fulfillment>('/me/fulfillment');
export const createShipment = (itemIds: string[], opts?: { mode?: string; private?: boolean }) =>
  req<Shipment>('/shipments', { method: 'POST', body: JSON.stringify({ itemIds, ...opts }) });
export const discardFulfillmentItem = (itemId: string) =>
  req<Fulfillment>('/shipment/discard', { method: 'POST', body: JSON.stringify({ itemId }) });
export const confirmReceived = (shipmentId: string) =>
  req<Fulfillment>('/shipment/confirm-received', { method: 'POST', body: JSON.stringify({ shipmentId }) });

export const getSellerShipments = () => req<Shipment[]>('/seller/shipments');
export const shipShipment = (shipmentId: string, trackingNumber?: string, carrier?: string) =>
  req<Shipment>('/seller/shipment/ship', { method: 'POST', body: JSON.stringify({ shipmentId, trackingNumber, carrier }) });

// ---- notifications ---------------------------------------------------------
export interface Notif {
  id: string;
  kind: string;
  title: string;
  body: string | null;
  href: string | null;
  read: boolean;
  createdAt: number;
}
export interface Notifs {
  unread: number;
  items: Notif[];
}
export const getNotifications = () => req<Notifs>('/me/notifications');
export const markNotificationsRead = () => req<Notifs>('/me/notifications/read', { method: 'POST', body: '{}' });

// ---- deposits / withdrawals ------------------------------------------------
export const refreshMe = () => req<Session>('/me');
export const simulateDeposit = (amount: string) =>
  req<{ available: string }>('/dev/simulate-deposit', { method: 'POST', body: JSON.stringify({ amount }) });
export const withdraw = (amount: string, toAddress: string) =>
  req<{ status: string; txSig?: string; available: string }>('/withdraw', {
    method: 'POST',
    body: JSON.stringify({ amount, toAddress }),
  });

/** Restore the signed-in user from a saved token (called on app load). Only a
 *  real 401 clears the token — a transient/network error keeps you signed in. */
export async function restore(): Promise<Session | null> {
  const t = getToken();
  if (!t) return null;
  try {
    const r = await fetch(`${API}/me`, { headers: { authorization: `Bearer ${t}` } });
    if (r.status === 401) {
      clearToken();
      return null;
    }
    if (!r.ok) return null;
    return (await r.json()) as Session;
  } catch {
    return null; // network error — keep the token, retry next load
  }
}
