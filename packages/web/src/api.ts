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
  /** Name + street are required to buy a carrier label, so seller onboarding
   *  makes the ship-from step mandatory. */
  originName: string | null;
  originLine1: string | null;
  originLine2: string | null;
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
  /** Video source for this seller's stream, and whether native is provisioned. */
  streamSource?: 'pumpfun' | 'native';
  nativeEnabled?: boolean;
  /** False only when the account has an email it hasn't confirmed yet. */
  emailVerified?: boolean;
  streamTitle?: string | null;
  streamCategory?: string | null;
  /** Seller-uploaded cover art for their card on the live grid (data URL). */
  streamImage?: string | null;
  chatCooldownMs?: number;
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
 *  caller to clear the local token. Best-effort, never blocks signing out. */
export const logout = () =>
  req<{ ok: boolean }>('/auth/logout', { method: 'POST', body: '{}' }).catch(() => undefined);

/** Right-to-erasure: permanently wipe this user's personal data + disable the
 *  account. Irreversible; caller clears the local token afterward. */
export const eraseMyData = () => req<{ ok: boolean }>('/me/erase', { method: 'POST', body: '{}' });

/** Display a USDC decimal string with exactly 2 decimals ("5.5"→"5.50", "25"→"25.00"),
 *  rounded to the nearest cent, for shipping figures and wallet balances. */
export const money2 = (s: string | number) => Number(s).toFixed(2);

/** API failure carrying the backend's machine-readable code (when it sends one)
 *  so flows can branch (e.g. TX_EXPIRED → silently retry). Still an Error, so
 *  every existing `err instanceof Error` catch keeps working. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly code?: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function req<T>(path: string, opts: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = { 'content-type': 'application/json', ...(opts.headers as Record<string, string>) };
  const t = getToken();
  if (t) headers.authorization = `Bearer ${t}`;
  const r = await fetch(`${API}${path}`, { ...opts, headers });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const d = data as { error?: string; code?: string };
    throw new ApiError(d.error || 'Something went wrong. Try again.', d.code, r.status);
  }
  return data as T;
}

export async function register(email: string, password: string): Promise<Session> {
  // A ?ref= code captured at page load rides along so the referrer gets credit.
  const ref = localStorage.getItem('bidit_ref') ?? undefined;
  const s = await req<Session>('/auth/register', { method: 'POST', body: JSON.stringify({ email, password, ref }) });
  if (ref) localStorage.removeItem('bidit_ref');
  setToken(s.token);
  return s;
}

export async function login(email: string, password: string): Promise<Session> {
  const s = await req<Session>('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) });
  setToken(s.token);
  return s;
}

/** Confirm the emailed code. Returns the refreshed session (emailVerified true). */
export const verifyEmail = (code: string) =>
  req<Session>('/auth/verify-email', { method: 'POST', body: JSON.stringify({ code }) });

/** Mail a fresh code. Rejects if one was sent within the last minute. */
export const resendVerifyCode = () => req<{ ok: boolean }>('/auth/resend-code', { method: 'POST' });

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

/** Ask for a reset code. Always resolves, whether or not the email is known. */
export const forgotPassword = (email: string) =>
  req<{ ok: boolean }>('/auth/forgot-password', { method: 'POST', body: JSON.stringify({ email }) });

/** Set a new password with the emailed code. Signs every old session out. */
export const resetPassword = (email: string, code: string, password: string) =>
  req<{ ok: boolean }>('/auth/reset-password', {
    method: 'POST',
    body: JSON.stringify({ email, code, password }),
  });

/** Take a username during onboarding, so a clash is reported on that step. */
export async function setHandle(handle: string): Promise<Session> {
  const s = await req<Session>('/me/handle', { method: 'POST', body: JSON.stringify({ handle }) });
  setToken(s.token);
  return s;
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
  weightGrams: number | null;
  parcelPreset: string | null;
  parcel: { lengthMm: number; widthMm: number; heightMm: number } | null;
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

export interface AdminUser {
  id: string;
  handle: string;
  email: string | null;
  role: string;
  emailVerified: boolean;
  bannedAt: number | null;
  bannedReason: string | null;
  createdAt: number;
}

/** Admin: search accounts by handle or email. Empty query lists the suspended. */
export const adminFindUsers = (q: string) =>
  req<AdminUser[]>(`/admin/users?q=${encodeURIComponent(q)}`);

export const adminSetSellerVisibility = (userId: string, hidden: boolean) =>
  req<{ ok: boolean }>('/admin/seller/visibility', { method: 'POST', body: JSON.stringify({ userId, hidden }) });

export const adminBanUser = (userId: string, reason: string | null) =>
  req<{ ok: boolean }>('/admin/ban', { method: 'POST', body: JSON.stringify({ userId, reason }) });

export const adminUnbanUser = (userId: string) =>
  req<{ ok: boolean }>('/admin/unban', { method: 'POST', body: JSON.stringify({ userId }) });

export interface StatsPoint { t: number; n: number }
export interface AdminStats {
  users: {
    total: number; lastHour: number; lastDay: number; last7d: number;
    sellers: number; verifiedSellers: number;
    hourly: StatsPoint[]; daily: StatsPoint[];
  };
  money: {
    gmvUsd: string; orders: number;
    feesUsd: string; releasedOrders: number;
    refundedUsd: string; refundedOrders: number;
    buybackUsd: string; buybacks: number;
    depositedUsd: string; withdrawnUsd: string;
  };
}

export const adminStats = () => req<AdminStats>('/admin/stats');

export const applySeller = () => req<Session>('/seller/apply', { method: 'POST', body: '{}' });

export const submitSellerOnboarding = (payload: {
  website?: string;
  socials?: Record<string, string>;
  pitch?: string;
  coinAddress?: string;
  origin?: { name?: string; line1?: string; line2?: string; country?: string; region?: string; city?: string; postal?: string };
}) => req<Session>('/seller/onboarding', { method: 'POST', body: JSON.stringify(payload) });

export interface SellerApplication {
  userId: string;
  handle: string;
  displayName: string | null;
  email: string | null;
  verified: boolean;
  verifiedBy: string | null;
  hiddenFromLive: boolean;
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

/** Admin-only: force-move a pump.fun coin to a seller (the only way a claimed coin
 *  changes hands: self-serve claiming is first-claim-wins). */
export const adminReassignCoin = (sellerUserId: string, coinAddress: string) =>
  req<{ ok: boolean }>('/admin/seller-coin', { method: 'POST', body: JSON.stringify({ sellerUserId, coinAddress }) });

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

export interface OriginAddr { originCity: string | null; originRegion: string | null; originPostal: string | null; originCountry: string | null }
export interface LabelQueueRow {
  id: string;
  mode: string;
  shippingPaid: string;
  dims: { lengthCm: number | null; widthCm: number | null; heightCm: number | null; weightGrams: number | null };
  seller: { handle: string | null; name: string | null; origin: OriginAddr | null };
  buyer: { handle: string | null; address: Record<string, unknown> | null };
  items: { id: string; title: string; image: string | null }[];
  confirmedAt: number | null;
}
export const getLabelQueue = () => req<LabelQueueRow[]>('/admin/label-queue');
export const createLabel = (shipmentId: string, labelUrl: string, trackingNumber: string, carrier?: string) =>
  req<Shipment>('/admin/shipment/label', { method: 'POST', body: JSON.stringify({ shipmentId, labelUrl, trackingNumber, carrier }) });

// Admin test controls: drive the shipment pipeline by hand (Shippo does this in prod).
export interface InflightShipment {
  id: string;
  status: string; // LABEL_CREATED | SHIPPED | DELIVERED
  buyerHandle: string | null;
  sellerHandle: string | null;
  trackingNumber: string | null;
  releasable: boolean;
  items: { id: string; title: string }[];
}
export const getInflightShipments = () => req<InflightShipment[]>('/admin/shipments/inflight');
export const adminMarkShipped = (shipmentId: string) =>
  req<{ ok: boolean }>('/admin/shipment/mark-shipped', { method: 'POST', body: JSON.stringify({ shipmentId }) });
export const adminMarkDelivered = (shipmentId: string) =>
  req<{ ok: boolean }>('/admin/shipment/mark-delivered', { method: 'POST', body: JSON.stringify({ shipmentId }) });
export const adminReleaseNow = (shipmentId: string) =>
  req<{ ok: boolean }>('/admin/shipment/release-now', { method: 'POST', body: JSON.stringify({ shipmentId }) });

export interface LedgerAudit {
  accounts: { id: string; kind: string; handle: string | null; balance: string }[];
  systemTotal: string;
  buybackPending: string;
}
export const getLedgerAudit = () => req<LedgerAudit>('/admin/audit');

export interface WalletAudit {
  cluster: string;
  pendingLegs: number;
  reconciled: boolean;
  rows: { wallet: string; chain: string; ledger: string; diff: string }[];
}
export const getWalletAudit = () => req<WalletAudit>('/admin/wallet-audit');
export const getListings = () => req<SellerListing[]>('/seller/listings');
export const getSellerOrders = () => req<SellerOrder[]>('/seller/orders');

export interface SaleRow extends SellerOrder {
  kind: 'auction' | 'store' | 'giveaway';
}
export interface SalesPage { rows: SaleRow[]; total: number }

/** Full sales history: every order plus drawn giveaways, filtered + paginated. */
export const getSellerSales = (opts: {
  q?: string;
  kind?: 'auction' | 'store' | 'giveaway' | 'all';
  fromMs?: number;
  toMs?: number;
  skip?: number;
  take?: number;
} = {}) => {
  const p = new URLSearchParams({ v: '2' });
  if (opts.q) p.set('q', opts.q);
  if (opts.kind && opts.kind !== 'all') p.set('kind', opts.kind);
  if (opts.fromMs !== undefined) p.set('from', String(opts.fromMs));
  if (opts.toMs !== undefined) p.set('to', String(opts.toMs));
  if (opts.skip) p.set('skip', String(opts.skip));
  if (opts.take) p.set('take', String(opts.take));
  return req<SalesPage>(`/seller/orders?${p.toString()}`);
};

export const createListing = (body: {
  title: string;
  imageUrl?: string;
  startingBid: string;
  buyNowPrice?: string;
  quantity?: number;
  weightGrams?: number;
  /** Preset id from PARCEL_PRESETS, or 'custom' with `parcel` supplied. */
  parcelPreset?: string;
  parcel?: { lengthMm?: number; widthMm?: number; heightMm?: number };
}) => req<SellerListing>('/seller/listings', { method: 'POST', body: JSON.stringify(body) });

export const updateListing = (
  listingId: string,
  patch: {
    title?: string;
    imageUrl?: string;
    startingBid?: string;
    quantity?: number;
    weightGrams?: number | null;
    parcelPreset?: string;
    parcel?: { lengthMm?: number; widthMm?: number; heightMm?: number };
  },
) => req<SellerListing>('/seller/listing/update', { method: 'POST', body: JSON.stringify({ listingId, ...patch }) });

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

export const saveShippingSettings = (s: Omit<ShippingSettings, 'weeklyBundling' | 'shipLater' | 'privateShipping'>) =>
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

export const setSellerCoin = (coinAddress: string) =>
  req<{ ok: boolean }>('/seller/coin', { method: 'POST', body: JSON.stringify({ coinAddress }) });

// ---- seller coin auto-create ("<handle>'s BIDit Livestream") ---------------
export interface CoinCreatePrepared {
  attemptId: string;
  /** Null on the default (off-chain) path: pump.fun assigns the mint at create. */
  mint: string | null;
  mode: 'offchain' | 'pumpportal' | 'mock' | 'mock-offchain';
  /** What the wallet must sign: a plain pump.fun sign-in message (default, free
   *  and warning-free), a create transaction (on-chain escape hatch), or nothing. */
  signMode: 'none' | 'message' | 'transaction';
  /** The exact text to put in front of the wallet when signMode is 'message'. */
  loginMessage: string | null;
  /** The mint-signed create tx (base64) that Phantom signs, when signMode is 'transaction'. */
  txB64: string | null;
  /** b58 tx-message bytes (legacy signing lane; unused by the web client). */
  message: string | null;
  name: string;
  symbol: string;
}
export interface CoinCreateStatus {
  status: 'NONE' | 'PREPARED' | 'SUBMITTED' | 'CONFIRMED' | 'FAILED';
  attemptId?: string;
  mint?: string;
  txSig?: string | null;
  linkedCoin: string | null;
  error?: string | null;
}
export const prepareCoinCreate = (creatorWallet?: string) =>
  req<CoinCreatePrepared>('/seller/coin-create/prepare', {
    method: 'POST',
    body: JSON.stringify(creatorWallet ? { creatorWallet } : {}),
  });
export const submitCoinCreate = (p: {
  attemptId: string;
  publicKey?: string;
  /** base64 signature over the pump.fun sign-in message (default path). */
  loginSignature?: string;
  signature?: string;
  signedTxB64?: string;
}) => req<CoinCreateStatus>('/seller/coin-create/submit', { method: 'POST', body: JSON.stringify(p) });
export const getCoinCreateStatus = () => req<CoinCreateStatus>('/seller/coin-create/status');
// ---- chat moderators -------------------------------------------------------
export interface Moderator { userId: string; handle: string; addedAt: number }
export const getModerators = () => req<Moderator[]>('/seller/moderators');
export const addModerator = (handle: string) =>
  req<{ userId: string; handle: string }>('/seller/moderators', { method: 'POST', body: JSON.stringify({ handle }) });
export const removeModerator = (userId: string) =>
  req<{ ok: boolean }>('/seller/moderators/remove', { method: 'POST', body: JSON.stringify({ userId }) });

export const saveStreamSettings = (s: {
  streamTitle: string | null;
  streamCategory: string | null;
  streamImage?: string | null;
  chatCooldownMs?: number;
  pitch?: string | null;
}) => req<Session>('/seller/stream-settings', { method: 'POST', body: JSON.stringify(s) });

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
  coin: string | null;
  /** 'pumpfun' (linked coin's stream) or 'native' (BIDit-hosted). Native cards
   *  link to /live/@handle since they may have no coin. */
  streamSource: 'pumpfun' | 'native';
  sellerHandle: string;
  /** Seller's profile photo, if set; null falls back to the generated avatar. */
  sellerAvatar: string | null;
  room: string;
  hasAuction: boolean;
  hasGiveaway: boolean;
  streamLive: boolean;
  /** Sockets in the seller's room right now (people on the watch page). */
  viewers: number;
  verified: boolean;
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
  verified: boolean;
  sellerAvatar?: string | null;
  /** Seller's stream-card overrides: what the home grid shows, so the watch
   *  page must show it too. */
  streamTitle?: string | null;
  streamImage?: string | null;
  description?: string | null;
  /** Video source: 'pumpfun' (play the coin's pump.fun stream) or 'native'
   *  (BIDit-hosted). Drives which player the watch page mounts. */
  streamSource: 'pumpfun' | 'native';
  /** The linked pump.fun coin, if any (needed by the pump.fun player + link). */
  coin?: string | null;
  /** Native only: currently broadcasting + the Cloudflare iframe player URL. */
  isLiveNow: boolean;
  streamIframeUrl?: string | null;
}

/** Native-stream status for a room; the watch page polls this to notice go-live. */
export interface StreamStatus {
  source: 'pumpfun' | 'native';
  live: boolean;
  iframeUrl: string | null;
  hlsUrl: string | null;
  /** WebRTC (WHEP) playback for sub-second latency; player prefers it, falls back to iframe. */
  whepUrl: string | null;
  mock: boolean;
}
export const getStreamStatus = (room: string) =>
  req<StreamStatus>(`/stream/status?room=${encodeURIComponent(room)}`);

// ---- seller: native streaming (BIDit-hosted) ----
export const enableNativeStreaming = () =>
  req<{ source: string; liveInputId: string; mock: boolean }>('/seller/stream/enable-native', { method: 'POST' });
export const setStreamSource = (source: 'pumpfun' | 'native') =>
  req<{ source: string }>('/seller/stream/source', { method: 'POST', body: JSON.stringify({ source }) });
export interface StreamCredentials { rtmpsUrl: string; streamKey: string; whipUrl: string }
export const getStreamCredentials = () => req<StreamCredentials>('/seller/stream/credentials');
export interface Health { nativeStreaming: boolean }
export const getHealth = () => req<Health>('/health');

// ---- marketplace (timed auctions) ----
export const MARKET_REGIONS = ['US', 'CA', 'UK', 'EU', 'ASIA', 'OTHER'] as const;
export type MarketRegion = (typeof MARKET_REGIONS)[number];
/** micros string -> dollars number (display only). */
export const fromMicros = (m: string | null | undefined) => (m == null ? null : Number(m) / 1e6);

export type MarketSaleMode = 'auction' | 'fixed';
export interface MarketCard {
  /** Route key: auction id for auctions, listing id for buy-now. */
  id: string;
  saleMode: MarketSaleMode;
  auctionId: string | null;
  listingId: string;
  title: string;
  photo: string | null;
  category: string | null;
  currentBid: string | null;
  startingBid: string;
  buyNow: string | null;
  bidCount: number;
  endsAt: number | null;
  sellerHandle: string;
  sellerAvatar: string | null;
  sellerVerified: boolean;
  shipPrices: Record<string, string>;
  /** NFT auction: digital delivery, no shipping. nftCount > 1 = batch. */
  nft: boolean;
  nftCount: number;
}
export interface MarketList { items: MarketCard[]; total: number; page: number; pageSize: number }
export type MarketSort = 'ending' | 'newest' | 'price_asc' | 'price_desc';
export const getMarket = (opts: { category?: string; sort?: MarketSort; q?: string; page?: number; mode?: MarketSaleMode } = {}) => {
  const qs = new URLSearchParams();
  if (opts.category) qs.set('category', opts.category);
  if (opts.sort) qs.set('sort', opts.sort);
  if (opts.q) qs.set('q', opts.q);
  if (opts.page) qs.set('page', String(opts.page));
  if (opts.mode) qs.set('mode', opts.mode);
  const s = qs.toString();
  return req<MarketList>(`/market${s ? `?${s}` : ''}`);
};

export interface MarketItemDetail {
  id: string;
  saleMode: MarketSaleMode;
  auctionId: string | null;
  listingId: string;
  status: string;
  available: boolean;
  buyNow: string | null;
  title: string;
  description: string | null;
  category: string | null;
  photos: string[];
  startingBid: string;
  currentBid: string | null;
  minIncrementBps: number;
  minIncrementFloor: string;
  endsAt: number | null;
  serverNow: number;
  seller: { id: string; handle: string; avatarUrl: string | null; verified: boolean };
  shipPrices: Record<string, string>;
  nft: boolean;
  nftAssets: { name: string | null; image: string | null; collection: string | null }[];
  bids: { handle: string; amount: string; at: number; status: string }[];
  viewer: { region: MarketRegion; shippingC: string | null; hasAddress: boolean; leading: boolean } | null;
}
export const getMarketItem = (id: string) =>
  req<MarketItemDetail>(`/market/item?id=${encodeURIComponent(id)}`);

export const buyMarketItemApi = (listingId: string) =>
  req<{ ok: true; orderId: string; amount: string; shippingC: string; nft: boolean }>('/market/buy', {
    method: 'POST',
    body: JSON.stringify({ listingId }),
  });

export const delistMarketApi = (listingId: string) =>
  req<{ ok: true }>('/market/delist', { method: 'POST', body: JSON.stringify({ listingId }) });

export const placeMarketBidApi = (auctionId: string, amount: string) =>
  req<{ ok: true; currentBid: string | null; minNextBid: string; endsAt: number | null; extended: boolean; shippingC: string | null }>(
    '/market/bid',
    { method: 'POST', body: JSON.stringify({ auctionId, amount }) },
  );

export interface CreateMarketListingInput {
  title: string;
  description?: string;
  category?: string;
  photos: string[];
  saleMode?: MarketSaleMode;
  startingBid?: string;
  durationHours?: number;
  /** Fixed mode: the buy-now price in dollars, e.g. "40". */
  price?: string;
  /** region -> dollars string, e.g. { US: "15" }. */
  shipPrices: Record<string, string>;
}
export const createMarketListingApi = (input: CreateMarketListingInput) =>
  req<{ listingId: string; auctionId: string | null; endsAt: number | null; saleMode: MarketSaleMode }>(
    '/market/list',
    { method: 'POST', body: JSON.stringify(input) },
  );

export interface MyMarketRow {
  id: string; saleMode: MarketSaleMode; auctionId: string | null; listingId: string;
  title: string; photo: string | null; status: string;
  currentBid: string | null; startingBid: string; buyNow: string | null; bidCount: number; endsAt: number | null;
}
export const getMyMarket = () => req<MyMarketRow[]>('/market/mine');

// ---- offers (buy-now listings) + direct messages ----
export interface OfferCardData {
  offerId: string;
  listingId: string;
  buyerId: string;
  sellerId: string;
  amount: string;
  shippingC: string;
  counterAmount: string | null;
  status: string;
  expiresAt: number;
  listingTitle: string;
  listingPhoto: string | null;
  askingPrice: string | null;
}
export const makeOfferApi = (listingId: string, amount: string) =>
  req<{ ok: true; offerId: string; conversationId: string; shippingC: string; expiresAt: number }>('/market/offer', {
    method: 'POST',
    body: JSON.stringify({ listingId, amount }),
  });
export type OfferAction = 'accept' | 'decline' | 'counter' | 'cancel';
export const respondOfferApi = (offerId: string, action: OfferAction, counterAmount?: string) =>
  req<{ ok: true; status: string; orderId?: string }>('/market/offer/respond', {
    method: 'POST',
    body: JSON.stringify({ offerId, action, counterAmount }),
  });

export interface InboxRow {
  conversationId: string;
  other: { id: string; handle: string; avatarUrl: string | null };
  lastMessageAt: number;
  preview: string | null;
  previewKind: string;
  unread: number;
}
export interface ReferralInfo { code: string; referred: number; qualified: number; pointsEarned: string }
export const getReferralInfoApi = () => req<ReferralInfo>('/me/referral');
export interface ReferralLeaderRow { handle: string; avatarUrl: string | null; userId: string; qualified: number }
export const getReferralLeaders = () => req<ReferralLeaderRow[]>('/referral/leaders');

export const getInbox = () => req<InboxRow[]>('/messages');
export const getUnreadMessages = () => req<{ count: number }>('/messages/unread');
export interface ThreadMessage {
  id: string;
  senderId: string;
  kind: string;
  text: string | null;
  listingId: string | null;
  offerId: string | null;
  at: number;
}
export interface Thread {
  conversationId: string;
  other: { id: string; handle: string; avatarUrl: string | null; verified: boolean };
  messages: ThreadMessage[];
  offers: OfferCardData[];
  serverNow: number;
}
export const getThreadApi = (id: string, after?: number) =>
  req<Thread>(`/messages/thread?id=${encodeURIComponent(id)}${after ? `&after=${after}` : ''}`);
export const startConversationApi = (userId: string) =>
  req<{ conversationId: string }>('/messages/start', { method: 'POST', body: JSON.stringify({ userId }) });
export const sendMessageApi = (conversationId: string, text: string) =>
  req<{ ok: true; messageId: string }>('/messages/send', { method: 'POST', body: JSON.stringify({ conversationId, text }) });

// ---- NFT custody + NFT auctions ----
export interface NftAsset {
  id: string;
  mint: string;
  name: string | null;
  image: string | null;
  collection: string | null;
  standard: string | null;
  status: string; // HELD | WITHDRAWING | WITHDRAWN
  locked: boolean;
  listingId: string | null;
  marketplace: boolean;
  withdrawTxSig: string | null;
}
export const getMyNfts = () => req<NftAsset[]>('/nft/mine');
export const armNftDeposit = () =>
  req<{ depositAddress: string; watchUntil: number }>('/nft/arm', { method: 'POST', body: '{}' });
export const withdrawNftApi = (assetId: string, address: string) =>
  req<{ ok: true }>('/nft/withdraw', { method: 'POST', body: JSON.stringify({ assetId, address }) });
export const listNftForAuction = (input: {
  assetIds: string[];
  startingBid?: string;
  title?: string;
  mode: 'stream' | 'market';
  durationHours?: number;
  /** Market mode: sell at this set price instead of running an auction. */
  fixedPrice?: string;
}) => req<{ listingId: string; auctionId: string | null; endsAt: number | null }>('/nft/list', { method: 'POST', body: JSON.stringify(input) });
export const unlistNftApi = (listingId: string) =>
  req<{ ok: true }>('/nft/unlist', { method: 'POST', body: JSON.stringify({ listingId }) });

// ---- go-live alerts (follow a seller / a category) ----
export interface AlertPrefs {
  sellers: { sellerId: string; handle: string }[];
  categories: string[];
}
export const getMyAlerts = () => req<AlertPrefs>('/me/alerts');
export const setSellerLiveAlert = (sellerId: string, on: boolean) =>
  req<{ on: boolean }>('/me/alerts/seller', { method: 'POST', body: JSON.stringify({ sellerId, on }) });
export const setCategoryLiveAlert = (category: string, on: boolean) =>
  req<{ on: boolean; category: string }>('/me/alerts/category', { method: 'POST', body: JSON.stringify({ category, on }) });
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
/** Resolve a watch-page identifier to a seller room. Accepts a pump.fun coin, or
 *  a handle (with a leading @) for native streamers who have no coin. Returns
 *  null if nothing resolves (404). */
export async function resolveCoin(idOrHandle: string): Promise<ResolvedRoom | null> {
  const q = idOrHandle.startsWith('@')
    ? `handle=${encodeURIComponent(idOrHandle.slice(1))}`
    : `coin=${encodeURIComponent(idOrHandle)}`;
  try {
    return await req<ResolvedRoom>(`/resolve?${q}`);
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
  /** A giveaway prize (free item): shipping is the only cost. */
  giveaway?: boolean;
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

/** A real carrier quote for a shipment the buyer is about to pay for. `quoteId`
 *  is what makes it payable: the charge consumes it, so the amount taken is
 *  always the amount shown. Null when there is no address to price against. */
export interface ShipEstimate {
  quoteId: string | null;
  shippingFee: string;
  privacyFee: string;
  total: string;
  carrier: string;
  service: string;
  estDays: number | null;
  hasAddress: boolean;
}

/** The bid panel's "~$ est. shipping". Display only: what the buyer actually
 *  pays is quoted live at ship time and can differ by a couple of dollars. */
export interface ListingShipEstimate {
  shippingFee: string;
  privacyFee: string;
  hasAddress: boolean;
  /** No saved address, so this is the cheapest lane, not a quote for them. */
  isFrom: boolean;
}

export interface Purchase {
  id: string;
  title: string;
  image: string | null;
  amount: string;
  stage: 'to_ship' | 'in_transit' | 'delivered';
  /** Won at auction (as opposed to bought outright): gates "I just won" sharing. */
  won?: boolean;
  /** A giveaway prize the user won (free, ships like any item). */
  giveaway?: boolean;
  tracking: string | null;
  carrier: string | null;
  deliveredAt: number | null;
}
export const getPurchases = () => req<Purchase[]>('/me/purchases');

export const getFulfillment = () => req<Fulfillment>('/me/fulfillment');
export const estimateShipment = (itemIds: string[], opts?: { private?: boolean }) =>
  req<ShipEstimate>('/shipments/estimate', { method: 'POST', body: JSON.stringify({ itemIds, ...opts }) });
export const estimateListingShipping = (listingId: string) =>
  req<ListingShipEstimate>('/shipping/quote-listing', { method: 'POST', body: JSON.stringify({ listingId }) });
/** `quoteId` comes from estimateShipment and is what gets charged. Without it the
 *  server refuses rather than pricing the shipment a second time. */
export const createShipment = (
  itemIds: string[],
  opts?: { mode?: string; private?: boolean; quoteId?: string | null },
) => req<Shipment>('/shipments', { method: 'POST', body: JSON.stringify({ itemIds, ...opts }) });
export const discardFulfillmentItem = (itemId: string) =>
  req<Fulfillment>('/shipment/discard', { method: 'POST', body: JSON.stringify({ itemId }) });
export const confirmReceived = (shipmentId: string) =>
  req<Fulfillment>('/shipment/confirm-received', { method: 'POST', body: JSON.stringify({ shipmentId }) });
export interface DisputeInput { reason: string; detail: string; photos: string[] }
export const disputeShipment = (shipmentId: string, input: DisputeInput) =>
  req<Fulfillment>('/shipment/dispute', { method: 'POST', body: JSON.stringify({ shipmentId, ...input }) });

export const getSellerShipments = () => req<Shipment[]>('/seller/shipments');
export interface PackageDims { lengthCm: number; widthCm: number; heightCm: number; weightGrams: number }
/** Seller confirms the package size → BIDit generates the shipping label. This is
 *  the seller's only shipping action; the carrier's scans drive shipped → delivered. */
export const confirmShipmentLabel = (shipmentId: string, dims: PackageDims) =>
  req<Shipment>('/seller/shipment/confirm-label', { method: 'POST', body: JSON.stringify({ shipmentId, ...dims }) });

export interface HeldItem {
  id: string;
  title: string;
  image: string | null;
  buyerHandle: string | null;
  heldUntil: number | null;
}
export const getSellerHeld = () => req<HeldItem[]>('/seller/held');
/** Seller clears a held win whose 14-day hold expired (buyer never paid shipping).
 *  Forfeit: the seller keeps the item, and any escrowed payment releases to them. */
export const discardHeldItem = (itemId: string) =>
  req<{ ok: boolean }>('/seller/held/discard', { method: 'POST', body: JSON.stringify({ itemId }) });

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
export const simulateSolDeposit = (sol: string) =>
  req<{ available: string }>('/dev/simulate-sol-deposit', { method: 'POST', body: JSON.stringify({ sol }) });

export interface SolRate {
  enabled: boolean;
  unavailable?: boolean;
  usdPerSol?: string;
  creditPerSol?: string; // USD credited per 1 SOL, after the conversion fee
  spreadBps?: number;
  source?: string;
}
export const getSolRate = () => req<SolRate>('/deposit/sol-rate');
export const withdraw = (amount: string, toAddress: string) =>
  req<{ status: string; txSig?: string; available: string }>('/withdraw', {
    method: 'POST',
    body: JSON.stringify({ amount, toAddress }),
  });

/** Restore the signed-in user from a saved token (called on app load). Only a
 *  real 401 clears the token: a transient/network error keeps you signed in. */
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
    return null; // network error: keep the token, retry next load
  }
}

// ---- address validation -----------------------------------------------------

/** Advisory only. `unchecked` means we could not reach the carrier, which is not
 *  a reason to stop anyone saving their own address. */
export interface AddressCheck {
  status: 'ok' | 'warning' | 'unchecked';
  messages: string[];
  suggestion: {
    line1?: string;
    line2?: string;
    city?: string;
    region?: string;
    postal?: string;
    country?: string;
  } | null;
}

export const validateAddress = (a: {
  name?: string;
  line1?: string;
  city?: string;
  region?: string;
  postal?: string;
  country?: string;
}) => req<AddressCheck>('/address/validate', { method: 'POST', body: JSON.stringify(a) });
