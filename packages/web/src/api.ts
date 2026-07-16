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

export type ShippingMode = 'WEEKLY_BUNDLE' | 'SHIP_LATER' | 'PRIVATE';

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
  shippingMode?: ShippingMode;
  depositAddress: string | null;
  cluster?: 'mock' | 'devnet' | 'mainnet-beta';
  interests: string[];
  onboarded: boolean;
  role: string;
  verified: boolean;
  isSeller?: boolean;
  isAdmin?: boolean;
  sellerOnboarded?: boolean;
  fulfilledCount?: number;
  verifyThreshold?: number;
  pumpCoinAddress: string | null;
  streamTitle?: string | null;
  streamCategory?: string | null;
  website?: string | null;
  socials?: Record<string, string> | null;
  pitch?: string | null;
  shipping?: ShippingSettings;
  available: string;
  settled: string;
}

export const getToken = () => localStorage.getItem(TOKEN_KEY);
export const setToken = (t: string) => localStorage.setItem(TOKEN_KEY, t);
export const clearToken = () => localStorage.removeItem(TOKEN_KEY);

/** Revoke this session server-side (log out everywhere), then it's up to the
 *  caller to clear the local token. Best-effort — never blocks signing out. */
export const logout = () =>
  req<{ ok: boolean }>('/auth/logout', { method: 'POST', body: '{}' }).catch(() => undefined);

/** Right-to-erasure: permanently wipe this user's personal data + disable the
 *  account. Irreversible; caller clears the local token afterward. */
export const eraseMyData = () => req<{ ok: boolean }>('/me/erase', { method: 'POST', body: '{}' });

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
  shippingMode?: ShippingMode;
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
  buyNowPrice: string | null;
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

export const submitSellerOnboarding = (payload: {
  website?: string;
  socials?: Record<string, string>;
  pitch?: string;
  coinAddress?: string;
  origin?: { country?: string; region?: string; city?: string; postal?: string };
}) => req<Session>('/seller/onboarding', { method: 'POST', body: JSON.stringify(payload) });

export interface SellerApplication {
  userId: string;
  handle: string;
  displayName: string | null;
  email: string | null;
  verified: boolean;
  verifiedBy: string | null;
  appliedAt: number | null;
  onboarded: boolean;
  fulfilledCount: number;
  threshold: number;
  pitch: string | null;
  website: string | null;
  socials: Record<string, string> | null;
  pumpCoinAddress: string | null;
  origin: { country: string | null; region: string | null; city: string | null; postal: string | null };
}
export const getSellerApplications = () => req<SellerApplication[]>('/admin/sellers');
export const verifySellerAdmin = (sellerUserId: string) =>
  req<{ ok: boolean }>('/admin/verify-seller', { method: 'POST', body: JSON.stringify({ sellerUserId }) });

// ---- launch "$100 to sell" promo ----
export interface PromoState {
  active: boolean;
  bonusUsd: number;
  thresholdUsd: number;
  startMs: number | null;
  enrollEndsMs: number | null;
}
export const getPromo = () => req<PromoState>('/promo');

export interface SellerPromoStatus {
  promoActive: boolean;
  enrolled: boolean;
  fulfilledUsd: string;
  thresholdUsd: number;
  bonusUsd: number;
  earned: boolean;
  paid: boolean;
}
export const getSellerPromo = () => req<SellerPromoStatus>('/seller/promo');

export interface PromoSellerRow {
  userId: string;
  handle: string;
  email: string | null;
  joinedAt: number;
  fulfilledUsd: string;
  earned: boolean;
  paidAt: number | null;
  payoutWalletAddress: string | null;
}
export interface AdminPromo {
  configured: boolean;
  startMs: number | null;
  enrollEndsMs: number | null;
  bonusUsd: number;
  active: boolean;
  sellers: PromoSellerRow[];
}
export const getAdminPromo = () => req<AdminPromo>('/admin/promo');
export const markPromoPaid = (sellerUserId: string) =>
  req<{ ok: boolean }>('/admin/promo/mark-paid', { method: 'POST', body: JSON.stringify({ sellerUserId }) });

export interface AdminOrder {
  id: string;
  status: string;
  title: string;
  amount: string;
  platformFee: string;
  sellerProceeds: string;
  buyer: string;
  seller: string;
  trackingNumber: string | null;
  createdAt: number;
  disputeWindowEndsAt: number | null;
  noShipDeadline: number | null;
}
export const getAdminOrders = () => req<AdminOrder[]>('/admin/orders');
export const adminOrderAction = (orderId: string, action: string, tracking?: string) =>
  req<{ status: string }>('/admin/order/action', { method: 'POST', body: JSON.stringify({ orderId, action, tracking }) });

export interface LedgerAudit {
  accounts: { id: string; kind: string; handle: string | null; balance: string }[];
  systemTotal: string;
  buybackPending: string;
}
export const getLedgerAudit = () => req<LedgerAudit>('/admin/audit');
export const getListings = () => req<SellerListing[]>('/seller/listings');
export const getSellerOrders = () => req<SellerOrder[]>('/seller/orders');

export const createListing = (body: {
  title: string;
  imageUrl?: string;
  startingBid: string;
  buyNowPrice?: string;
  quantity?: number;
  weightGrams?: number;
}) => req<SellerListing>('/seller/listings', { method: 'POST', body: JSON.stringify(body) });

export const setStorePrice = (listingId: string, buyNowPrice: string | null) =>
  req<SellerListing>('/seller/listing/store-price', {
    method: 'POST',
    body: JSON.stringify({ listingId, buyNowPrice }),
  });

// ---- seller store (buy now) -------------------------------------------------
export interface ShopItem {
  id: string;
  title: string;
  description: string | null;
  price: string;
  image: string | null;
  quantity: number;
}
export interface ShopData {
  linked: boolean;
  sellerHandle: string | null;
  items: ShopItem[];
}
export const getShop = (coin: string) => req<ShopData>(`/shop?coin=${encodeURIComponent(coin)}`);
export const buyShopItem = (listingId: string) =>
  req<{ ok: boolean; orderId: string; amount: string }>('/shop/buy', {
    method: 'POST',
    body: JSON.stringify({ listingId }),
  });

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
export const saveStreamSettings = (s: { streamTitle: string | null; streamCategory: string | null }) =>
  req<Session>('/seller/stream-settings', { method: 'POST', body: JSON.stringify(s) });

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
  streamTitle: string | null;
  category: string | null;
  country: string | null;
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

export interface PumpStream {
  linked: boolean;
  live: boolean;
  title: string | null;
  thumbnail: string | null;
  host?: string;
  token?: string;
}
export const getPumpStream = (mint: string) => req<PumpStream>(`/pump/stream?mint=${encodeURIComponent(mint)}`);
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
  status: string; // PENDING_PAYMENT | PAID | LABEL_PENDING | LABEL_CREATED | SHIPPED | DELIVERED | CANCELED
  shippingFee: string;
  privacyFee: string;
  trackingNumber: string | null;
  carrier: string | null;
  lengthCm: number | null;
  widthCm: number | null;
  heightCm: number | null;
  packageWeightG: number | null;
  labelUrl: string | null;
  shipTo: unknown;
  sellerHandle: string | null;
  buyerHandle: string | null;
  createdAt: number;
  paidAt: number | null;
  confirmedAt: number | null;
  labelCreatedAt: number | null;
  shippedAt: number | null;
  items: ShipmentItem[];
}
export interface Fulfillment {
  items: FulfillmentItem[];
  shipments: Shipment[];
}

export interface ShipEstimate {
  shippingFee: string;
  carrierRetail: string;
  discountPct: number;
  privacyFee: string;
  total: string;
  hasAddress: boolean;
}

export interface ListingShipEstimate {
  shippingFee: string;
  carrierRetail: string;
  discountPct: number;
  privacyFee: string;
  hasAddress: boolean;
}

export const getFulfillment = () => req<Fulfillment>('/me/fulfillment');
export const estimateShipment = (itemIds: string[], opts?: { private?: boolean }) =>
  req<ShipEstimate>('/shipments/estimate', { method: 'POST', body: JSON.stringify({ itemIds, ...opts }) });
export const estimateListingShipping = (listingId: string) =>
  req<ListingShipEstimate>('/shipping/quote-listing', { method: 'POST', body: JSON.stringify({ listingId }) });
export const createShipment = (itemIds: string[], opts?: { mode?: string; private?: boolean }) =>
  req<Shipment>('/shipments', { method: 'POST', body: JSON.stringify({ itemIds, ...opts }) });
export const discardFulfillmentItem = (itemId: string) =>
  req<Fulfillment>('/shipment/discard', { method: 'POST', body: JSON.stringify({ itemId }) });
export const confirmReceived = (shipmentId: string) =>
  req<Fulfillment>('/shipment/confirm-received', { method: 'POST', body: JSON.stringify({ shipmentId }) });

export const getSellerShipments = () => req<Shipment[]>('/seller/shipments');
export interface PackageDims { lengthCm: number; widthCm: number; heightCm: number; weightGrams: number }
/** Seller confirms the package size → BIDit generates the shipping label. */
export const confirmShipmentLabel = (shipmentId: string, dims: PackageDims) =>
  req<Shipment>('/seller/shipment/confirm-label', { method: 'POST', body: JSON.stringify({ shipmentId, ...dims }) });
/** Seller marks the (labelled) package dropped off with the carrier. */
export const shipShipment = (shipmentId: string) =>
  req<Shipment>('/seller/shipment/ship', { method: 'POST', body: JSON.stringify({ shipmentId }) });

export interface HeldItem {
  id: string;
  title: string;
  image: string | null;
  buyerHandle: string | null;
  heldUntil: number | null;
}
export const getSellerHeld = () => req<HeldItem[]>('/seller/held');

// ---- BIDit Points ----------------------------------------------------------
export type MissionStatus = 'locked' | 'claimable' | 'claimed';
export interface Mission {
  id: string;
  title: string;
  desc: string;
  points: number;
  status: MissionStatus;
  comingSoon: boolean;
}
export interface PointsSummary {
  points: number;
  missions: Mission[];
}
export interface LeaderboardRow {
  rank: number;
  handle: string;
  displayName: string | null;
  avatarUrl: string | null;
  points: number;
}

export const getPoints = () => req<PointsSummary>('/points');
export const claimMission = (missionId: string) =>
  req<{ points: number; total: number }>('/points/claim', { method: 'POST', body: JSON.stringify({ missionId }) });
export const getLeaderboard = () => req<LeaderboardRow[]>('/points/leaderboard');

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
