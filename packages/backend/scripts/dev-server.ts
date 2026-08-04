/**
 * Local dev server (Chunk 6). Serves the static surfaces (buyer dumb page,
 * seller dashboard, admin page), the auth + seller + admin REST API, the dev
 * conveniences, and hosts the RealtimeServer on the same http server.
 *
 * Run: npm run dev  -> http://localhost:8787
 *   /         buyer dumb test page        /seller   seller dashboard
 *   /admin    admin tools
 */
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Role, AuctionStatus, usdc, formatUsdc, normalizeWheelEntries } from '@bidit/shared';
import { InsufficientFundsError } from '../src/errors.js';
import { prisma } from '../src/db.js';
import { ensureSystemAccounts } from '../src/bootstrap.js';
import { assertStartupConfig, usingDefaultAuthSecret } from '../src/config.js';
import { corsAllowOrigin, corsAllowlist } from '../src/http.js';
import { decryptPii, piiEncryptionEnabled } from '../src/pii.js';
import { getOrCreateUserAccount, deposit, getAvailableBalance, getSettledBalance } from '../src/ledger.js';
import { RealtimeServer } from '../src/realtime/server.js';
import {
  issueSession,
  verifySession,
  parseBearer,
  buildLoginChallenge,
  verifyWalletSignature,
  isValidWalletAddress,
  issueWsTicket,
  verifyPassword,
} from '../src/auth.js';
import {
  findOrCreateByWallet,
  findOrCreateByHandle,
  getUser,
  registerWithEmail,
  loginWithEmail,
  updateProfile,
  completeOnboarding,
  applyAsSeller,
  submitSellerOnboarding,
  isAdmin,
  banUser,
  unbanUser,
  requireSeller,
  AuthError,
  revokeUserSessions,
  loadSessionRevocations,
  eraseUserData,
  setHandle,
} from '../src/authz.js';
import { requestPasswordReset, resetPassword } from '../src/password-reset.js';
import { sendEmail, emailShell, paragraph, emailEnabled, emailFrom } from '../src/email.js';
import { decodeDataUrl, mediaUrl, MEDIA_MAX_AGE_S } from '../src/media.js';
import {
  sendVerificationCode,
  verifyEmailCode,
  backfillLegacyVerified,
  requireVerifiedEmail,
} from '../src/email-verify.js';
import { sellerFulfilledCount, VERIFY_THRESHOLD } from '../src/seller-verify.js';
import { promoState, sellerPromoStatus, listPromoSellers, markPromoPaid } from '../src/promo.js';
import {
  resolveRoomByCoin,
  linkCoinToSeller,
  seedRunningAuction,
  setSellerCoin,
  reassignCoin,
  backfillRenamedCategories,
  startAuctionFromListing,
} from '../src/sellers.js';
import { createListing, listSellerListings, setListingWheel, setListingStorePrice } from '../src/listings.js';
import { purchaseListing, listStoreItems, ItemUnavailableError } from '../src/store.js';
import { openGiveaway, getOpenGiveaway } from '../src/giveaways.js';
import {
  CHAT_COOLDOWN_MS,
  canModerateRoom,
  listRoomModerators,
  addRoomModerator,
  removeRoomModerator,
} from '../src/chat.js';
import { getPointsSummary, claimMission, getLeaderboard, PointsError } from '../src/points.js';
import { verifySeller, listSellers, ledgerAudit } from '../src/admin.js';
import { reconcileWallets } from '../src/audit.js';
import { DevWalletEscrow, ProgramEscrow } from '../src/escrow.js';
import { getChainClient, MockChain } from '../src/chain/index.js';
import { getPumpCreateProvider } from '../src/chain/pump-provider.js';
import { prepareCoinCreate, submitCoinCreate, getCoinCreateStatus } from '../src/pump-create.js';
import { ensureDepositAddress, DepositWatcher, registerAllDeposits } from '../src/deposits.js';
import { requestWithdrawal, WithdrawalError, WithdrawalReconciler } from '../src/withdrawals.js';
import {
  markShipped,
  markDelivered,
  openDispute,
  resolveDispute,
  releaseOrder,
  processOrderTimers,
  advanceOrdersForShipment,
  disputeShipment,
  releaseOrdersForShipment,
  buyerDiscardItem,
  sellerDiscardExpiredItem,
  type DisputeOutcome,
} from '../src/orders.js';
import { getTrackingProvider, ShipmentTracker } from '../src/tracking.js';
import { diagnoseShipping, type ShippoAddress } from '../src/shippo.js';
import { QuoteStaleError } from '../src/ship-charge.js';
import { ChainSettler } from '../src/chain-settle.js';
import {
  getBuyerFulfillment,
  getBuyerPurchases,
  getSellerShipments,
  getSellerHeldItems,
  listPrivateShipments,
  listLabelQueue,
  listInflightShipments,
  shipmentItems,
  createAndPayShipment,
  estimateShipment,
  estimateListingShipping,
  confirmShipmentForLabel,
  createShipmentLabel,
  markShipmentShipped,
  markShipmentDelivered,
  processFulfillmentTimers,
  ShippingError,
  type ShipMode,
} from '../src/fulfillment.js';
import { listNotifications, markAllRead, notify } from '../src/notifications.js';
import { systemClock } from '../src/clock.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 8787);

// Last-resort safety net: log stray async errors instead of letting Node crash
// the whole server (Node exits on an unhandled rejection by default). A payments
// backend must stay up; individual operations already handle their own failures.
process.on('unhandledRejection', (reason) => console.error('[unhandledRejection]', reason));
process.on('uncaughtException', (err) => console.error('[uncaughtException]', err));
const DEMO_SELLER_HANDLE = 'demo_seller';

// ---- CORS: reflect the caller in dev; strict allowlist in production (src/http.ts) ----
/** Set CORS headers for this request. Called once at the top of route() so every
 *  response (including error + preflight) carries them via res.setHeader. */
function applyCors(req: http.IncomingMessage, res: http.ServerResponse): void {
  const origin = typeof req.headers.origin === 'string' ? req.headers.origin : '';
  const allow = corsAllowOrigin(origin);
  if (allow) res.setHeader('access-control-allow-origin', allow);
  res.setHeader('vary', 'Origin');
  res.setHeader('access-control-allow-methods', 'GET, POST, PATCH, PUT, DELETE, OPTIONS');
  res.setHeader('access-control-allow-headers', 'content-type, authorization');
}

/**
 * The caller's real IP.
 *
 * Behind Render (and any other load balancer) the socket address is the PROXY,
 * so keying limits on it put every user in ONE bucket: it could not isolate an
 * attacker, and eleven requests a minute from anybody 429'd login, register and
 * password reset for the entire site. X-Forwarded-For is a client-settable
 * header, so it is only trusted when BIDIT_TRUST_PROXY says we are actually
 * behind one; otherwise a spoofed header would defeat the limiter completely.
 *
 * XFF is "client, proxy1, proxy2...". We take the RIGHTMOST entry after dropping
 * `trust` hops, because the leftmost values are the ones a client can forge.
 */
const TRUSTED_PROXY_HOPS = Math.max(0, Number(process.env.BIDIT_TRUST_PROXY ?? '0') || 0);
export function clientIp(req: http.IncomingMessage): string {
  const socketIp = req.socket.remoteAddress ?? 'unknown';
  if (TRUSTED_PROXY_HOPS === 0) return socketIp;
  const raw = req.headers['x-forwarded-for'];
  const chain = (Array.isArray(raw) ? raw.join(',') : raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (chain.length === 0) return socketIp;
  // Walk in from the right by the number of proxies we run behind.
  const idx = Math.max(0, chain.length - TRUSTED_PROXY_HOPS);
  return chain[idx] ?? chain[chain.length - 1] ?? socketIp;
}

// Throttle auth endpoints per-IP to blunt credential-stuffing / brute force.
const authHits = new Map<string, number[]>();
function authRateLimited(req: http.IncomingMessage): boolean {
  const ip = clientIp(req);
  const now = Date.now();
  // Now that keys are real client IPs rather than one proxy address, the map
  // would grow without bound. Sweep dead entries when it gets large.
  if (authHits.size > 10_000) {
    for (const [k, v] of authHits) if (!v.some((t) => now - t < 60_000)) authHits.delete(k);
  }
  const recent = (authHits.get(ip) ?? []).filter((t) => now - t < 60_000);
  recent.push(now);
  authHits.set(ip, recent);
  return recent.length > 10; // >10 attempts / minute / IP
}

// Throttle money endpoints per-USER (withdraw, buy). The balance check + daily cap
// already stop overspend; this blunts request floods that would hammer the DB/RPC.
const moneyHits = new Map<string, number[]>();
function moneyRateLimited(userId: string): boolean {
  const now = Date.now();
  const recent = (moneyHits.get(userId) ?? []).filter((t) => now - t < 60_000);
  recent.push(now);
  moneyHits.set(userId, recent);
  return recent.length > 20; // >20 money actions / minute / user
}

// Throttle coin-create PREPAREs per-USER: each one costs two external API calls
// (pump.fun IPFS + PumpPortal). Submits/status share the money limiter instead.
const coinCreateHits = new Map<string, number[]>();
function coinCreateRateLimited(userId: string): boolean {
  const now = Date.now();
  const recent = (coinCreateHits.get(userId) ?? []).filter((t) => now - t < 600_000);
  recent.push(now);
  coinCreateHits.set(userId, recent);
  return recent.length > 5; // >5 prepares / 10 min / user
}

function send(res: http.ServerResponse, status: number, body: unknown, type = 'application/json') {
  const payload = type === 'application/json' ? JSON.stringify(body) : String(body);
  res.writeHead(status, { 'content-type': type }); // CORS headers already set via applyCors()
  res.end(payload);
}

/** Body-size / malformed-JSON error, mapped to its HTTP status by the route catch. */
class RequestBodyError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'RequestBodyError';
  }
}

// 4 MB: comfortably fits the app's largest legitimate body (a listing with a few
// downscaled JPEG data-URL photos) while bounding memory per request. Override
// with BIDIT_MAX_BODY_BYTES.
const MAX_BODY_BYTES = (() => {
  const raw = Number(process.env.BIDIT_MAX_BODY_BYTES);
  return Number.isFinite(raw) && raw > 0 ? raw : 4_000_000;
})();

async function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    throw new RequestBodyError(413, 'Request body too large.');
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    total += (chunk as Buffer).length;
    if (total > MAX_BODY_BYTES) throw new RequestBodyError(413, 'Request body too large.');
    chunks.push(chunk as Buffer);
  }
  if (total === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString());
  } catch {
    throw new RequestBodyError(400, 'Malformed JSON body.');
  }
  // Every endpoint expects a JSON object; anything else is treated as empty.
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
}

const authUser = (req: http.IncomingMessage): string | null =>
  verifySession(parseBearer(req.headers.authorization));

async function serve(res: http.ServerResponse, file: string) {
  const html = await readFile(path.resolve(here, '../public', file), 'utf8');
  return send(res, 200, html, 'text/html');
}

async function main() {
  await ensureSystemAccounts(prisma);
  await ensureAdmin();
  // Hydrate session-revocation cutoffs so logouts survive a restart.
  await loadSessionRevocations(prisma).catch((e) => console.error('[auth] load revocations failed:', e));

  // Direct-payout mode (BIDIT_PAYOUT_MODE=direct): on a sale, pay the seller 100%
  // immediately, no escrow, no 5% fee. Used for the real-money friends test.
  const directPayout = process.env.BIDIT_PAYOUT_MODE === 'direct';
  const chain = await getChainClient(); // MockChain unless SOLANA_RPC is set
  // Seller coin auto-create ("<handle>'s BIDit Livestream"): PumpPortal on
  // mainnet, mock elsewhere; BIDIT_PUMP_PROVIDER overrides for spikes.
  const pumpCreate = getPumpCreateProvider(chain.cluster);
  // In escrow mode use the chain-backed ProgramEscrow (durable ChainTransfer outbox
  // → real wallet segregation); in direct mode nothing calls escrow for settlement,
  // so the ledger-only DevWalletEscrow suffices.
  const escrow = directPayout ? new DevWalletEscrow(prisma) : new ProgramEscrow(chain, prisma);
  // Fail fast on an unsafe production/real-money configuration (missing/weak
  // AUTH_SECRET, a mock chain in prod, force-enabled dev endpoints, missing
  // custody secrets). Throws → main().catch → process.exit(1).
  const { isProd } = assertStartupConfig(chain.cluster);
  // Escrow mode moves real USDC between segregated wallets: refuse to boot if any
  // of escrow/buyback/fee collapses onto treasury (a missing *_SECRET falls back to
  // treasury), which would silently commingle held funds and fees.
  if (!directPayout && isProd) {
    const addr = { treasury: chain.walletAddress('treasury'), escrow: chain.walletAddress('escrow'), buyback: chain.walletAddress('buyback'), fee: chain.walletAddress('fee') };
    const dupes = (['escrow', 'buyback', 'fee'] as const).filter((w) => addr[w] === addr.treasury);
    if (dupes.length > 0) {
      throw new Error(
        `Refusing to run escrow mode: wallet(s) ${dupes.join(', ')} fall back to treasury, set ESCROW_SECRET/BUYBACK_SECRET/FEE_SECRET to distinct keypairs.`,
      );
    }
    if (new Set(Object.values(addr)).size !== 4) {
      throw new Error('Refusing to run escrow mode: treasury/escrow/buyback/fee wallets must all be distinct.');
    }
  }
  if (usingDefaultAuthSecret() && chain.cluster !== 'mock') {
    console.warn('[config] ⚠️  AUTH_SECRET is the insecure default on a real chain: set a strong value before exposing this deploy.');
  }
  if (isProd && corsAllowlist().length === 0) {
    console.warn('[config] ⚠️  BIDIT_ALLOWED_ORIGINS is empty in production: CORS is failing open (any origin). Set it to your web origin to lock this down.');
  }
  if (isProd && !piiEncryptionEnabled()) {
    console.warn('[config] ⚠️  BIDIT_PII_KEY is not set: shipping addresses are stored unencrypted. Set a strong key to encrypt PII at rest.');
  }
  // Register existing users so their deposits are watched across restarts.
  await registerAllDeposits(chain, prisma).catch((e) => console.error('[deposits] register', e));
  // Accounts that predate email verification are trusted (see the function's
  // note), without this, everyone who already signed up would be locked out.
  await backfillLegacyVerified(prisma)
    .then((n) => n > 0 && console.log(`[verify] backfilled ${n} pre-existing account(s) as verified`))
    .catch((e) => console.error('[verify] backfill', e));
  // The web's category list renamed "Clothes": move saved profiles with it so
  // their streams keep matching the browse filter.
  await backfillRenamedCategories(prisma)
    .then((n) => n > 0 && console.log(`[sellers] renamed stream category on ${n} profile(s)`))
    .catch((e) => console.error('[sellers] category backfill', e));
  const httpServer = http.createServer((req, res) => void route(req, res));
  const realtime = new RealtimeServer({
    prisma,
    clock: systemClock,
    httpServer,
    escrow: directPayout ? undefined : escrow,
    directPayout,
  });
  // Watch the chain for inbound USDC and credit the ledger (deposit detection).
  // On each credit, push a live BALANCE_UPDATE so the depositor's balance updates
  // on-screen without a refresh. Poll fast on the mock chain (no real RPC), but
  // gently on a real chain: a per-address balance read every few seconds across
  // all users otherwise hammers the RPC into 429s (BIDIT_DEPOSIT_POLL_MS overrides).
  const depositPollMs = Number(process.env.BIDIT_DEPOSIT_POLL_MS) || (chain.cluster === 'mock' ? 5000 : 20000);
  const depositWatcher = new DepositWatcher(chain, prisma, depositPollMs, (userId) =>
    void realtime.notifyBalance(userId).catch(() => {}),
  );
  // Recover any deposit that was swept on-chain but not yet credited before a
  // prior crash/restart, then start the live poller.
  await depositWatcher.reconcile().then(
    (n) => n > 0 && console.log(`[deposits] reconciled ${n} pending deposit(s) on startup`),
    (e) => console.error('[deposits] startup reconcile failed:', e),
  );
  depositWatcher.start();
  // Finalize any withdrawal left mid-flight (SUBMITTED) by a prior crash/restart:
  // confirm it, or reverse the debit if the chain proves it never landed. Then
  // keep polling so in-flight withdrawals settle durably out of band. On each
  // terminal transition, push a live BALANCE_UPDATE (a reversal restores balance).
  const withdrawalReconciler = new WithdrawalReconciler(chain, prisma, 15_000, (userId) =>
    void realtime.notifyBalance(userId).catch(() => {}),
  );
  await withdrawalReconciler.reconcile().then(
    (n) => n > 0 && console.log(`[withdrawals] settled ${n} in-flight withdrawal(s) on startup`),
    (e) => console.error('[withdrawals] startup reconcile failed:', e),
  );
  withdrawalReconciler.start();
  // Track in-flight shipments via Shippo; on delivery, open the 2-day dispute
  // window on the order(s) (processOrderTimers then auto-releases). Only runs when
  // SHIPPO_API_KEY is set: otherwise delivery comes from buyer-confirm / admin.
  const trackingProvider = getTrackingProvider();
  if (trackingProvider) {
    const tracker = new ShipmentTracker(trackingProvider, prisma, systemClock, 120_000, (buyerId) => {
      void realtime.notifyBalance(buyerId).catch(() => {});
      void notify(
        { userId: buyerId, kind: 'delivered', title: 'Your order was delivered', body: 'If anything’s wrong, report a problem within 2 days. Otherwise you’re all set.', href: '/ship' },
        prisma,
      ).catch(() => {});
    });
    tracker.start();
    console.log('[tracking] Shippo shipment tracking enabled');
  } else {
    console.log('[tracking] SHIPPO_API_KEY not set: automatic delivery tracking off');
  }
  // Drive the durable escrow/shipping on-chain outbox (ChainTransfer) to the chain:
  // broadcast, confirm, and safely retry each internal wallet→wallet leg. Recover
  // any leg left mid-flight by a prior crash on startup, then poll. In direct mode
  // the outbox is empty (or same-wallet no-ops), so this is a harmless no-op.
  const chainSettler = new ChainSettler(chain, prisma, 8000);
  await chainSettler.reconcile().then(
    (n) => n > 0 && console.log(`[chain-settle] settled ${n} pending on-chain leg(s) on startup`),
    (e) => console.error('[chain-settle] startup reconcile failed:', e),
  );
  chainSettler.start();
  // Auto-discard Ready-to-Ship items past the 14-day ship-later hold.
  const fulfillmentTimer = setInterval(() => {
    void processFulfillmentTimers(systemClock, prisma).catch((e) => console.error('[fulfillment-timer]', e));
  }, 10 * 60_000);
  fulfillmentTimer.unref?.();
  // Escrow order timers: release funds once the dispute window passes, and refund
  // if a seller never ships. Harmless no-op in direct-payout mode (no held orders).
  const orderTimer = setInterval(() => {
    void processOrderTimers(escrow, systemClock, prisma).catch((e) => console.error('[order-timer]', e));
  }, 10 * 60_000);
  orderTimer.unref?.();

  // Dev endpoints (password-less login, balance minting, seeders) are ON only for
  // the local mock chain, OFF on any real chain unless explicitly forced, and
  // ALWAYS off in production (assertStartupConfig already rejected the force flag,
  // but this is defence-in-depth on the money-endpoint gate).
  const devEndpoints = !isProd && (chain.cluster === 'mock' || process.env.BIDIT_ENABLE_DEV_ENDPOINTS === 'yes');

  console.log(`[chain] cluster=${chain.cluster} · payout=${directPayout ? 'DIRECT (no escrow, no fee)' : 'escrow (95/5)'} · dev-endpoints=${devEndpoints ? 'on' : 'off'}`);
  // Email is the delivery path for verification + password-reset codes. Say
  // plainly whether it is live, since a missing key silently degrades to
  // "codes are only printed in these logs".
  if (emailEnabled()) {
    console.log(`[email] delivery ON · from=${emailFrom()}`);
  } else {
    console.warn('[email] ⚠️  RESEND_API_KEY not set: verification and reset codes are LOGGED, not delivered.');
  }
  if (chain.cluster === 'mainnet-beta') {
    console.log('[chain] ⚠️  MAINNET: REAL USDC WILL MOVE. treasury:', chain.walletAddress('treasury'));
  }

  async function sessionPayload(userId: string) {
    const user = await getUser(userId, prisma);
    if (!user) return null;
    const account = await prisma.account.findUnique({ where: { userId } });
    const profile = await prisma.sellerProfile.findUnique({ where: { userId } });
    return {
      token: issueSession(userId),
      userId,
      handle: user.handle,
      email: user.email,
      // Only meaningful when there IS an email; wallet/dev accounts are never gated.
      emailVerified: !user.email || user.emailVerified,
      displayName: user.displayName,
      avatarUrl: user.avatarUrl,
      bio: user.bio,
      shippingAddress: decryptPii(user.shippingAddress),
      bundleShipping: user.bundleShipping,
      shippingMode: user.shippingMode,
      interests: user.interests,
      onboarded: user.onboarded,
      role: user.role,
      walletAddress: user.walletAddress,
      // Selling: a SellerProfile means you're an active seller; `verified` is the
      // trust badge earned at VERIFY_THRESHOLD fulfilled orders (or by an admin).
      isSeller: profile != null,
      isAdmin: await isAdmin(userId, prisma),
      verified: profile?.verified === true,
      sellerOnboarded: profile?.onboardedSeller === true,
      fulfilledCount: profile ? await sellerFulfilledCount(userId, prisma) : 0,
      verifyThreshold: VERIFY_THRESHOLD,
      pumpCoinAddress: profile?.pumpCoinAddress ?? null,
      streamTitle: profile?.streamTitle ?? null,
      streamCategory: profile?.streamCategory ?? null,
      streamImage: profile?.streamImage ?? null,
      chatCooldownMs: profile?.chatCooldownMs ?? CHAT_COOLDOWN_MS,
      website: profile?.website ?? null,
      socials: (profile?.socials as Record<string, string> | null) ?? null,
      pitch: profile?.pitch ?? null,
      shipping: {
        originName: profile?.originName ?? null,
        originLine1: profile?.originLine1 ?? null,
        originLine2: profile?.originLine2 ?? null,
        originCountry: profile?.originCountry ?? null,
        originRegion: profile?.originRegion ?? null,
        originCity: profile?.originCity ?? null,
        originPostal: profile?.originPostal ?? null,
        weeklyBundling: profile?.weeklyBundling ?? false,
        shipLater: profile?.shipLater ?? false,
        privateShipping: profile?.privateShipping ?? false,
      },
      depositAddress: await ensureDepositAddress(userId, chain, prisma),
      cluster: chain.cluster, // 'mock' | 'devnet' | 'mainnet-beta', drives the deposit UI
      available: account ? formatUsdc(await getAvailableBalance(account.id, prisma)) : '0',
      settled: account ? formatUsdc(await getSettledBalance(account.id, prisma)) : '0',
    };
  }

  async function route(req: http.IncomingMessage, res: http.ServerResponse) {
    const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);
    applyCors(req, res); // set CORS on every response (incl. preflight + errors)
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }
    const p = url.pathname;
    /**
     * User-uploaded images, served as files rather than inlined in JSON.
     * Public by design: avatars and stream cover art are already shown to every
     * visitor. Cached hard: the URL carries a content hash, so an edited image
     * gets a different URL and can never be served stale.
     */
    if (req.method === 'GET' && (p === '/media/avatar' || p === '/media/cover' || p === '/media/listing')) {
      const id = url.searchParams.get('id') ?? '';
      if (!id) return send(res, 400, { error: 'missing id' });
      const stored =
        p === '/media/avatar'
          ? (await prisma.user.findUnique({ where: { id }, select: { avatarUrl: true } }))?.avatarUrl
          : p === '/media/cover'
            ? (await prisma.sellerProfile.findUnique({ where: { userId: id }, select: { streamImage: true } }))
                ?.streamImage
            : (await prisma.listing.findUnique({ where: { id }, select: { photos: true } }))?.photos[0];
      const img = decodeDataUrl(stored);
      if (!img) return send(res, 404, { error: 'not found' });
      // A matching ETag means the client already holds these exact bytes.
      if (req.headers['if-none-match'] === img.etag) {
        res.writeHead(304, { etag: img.etag, 'cache-control': `public, max-age=${MEDIA_MAX_AGE_S}` });
        return res.end();
      }
      res.writeHead(200, {
        'content-type': img.contentType,
        'content-length': String(img.body.length),
        etag: img.etag,
        'cache-control': `public, max-age=${MEDIA_MAX_AGE_S}, stale-while-revalidate=86400`,
      });
      return res.end(img.body);
    }
    // Operational transparency: which chain/payout/dev mode is this process in.
    // Unauthenticated + cheap; exposes only mode flags, never secrets or balances.
    if (req.method === 'GET' && p === '/health') {
      return send(res, 200, {
        ok: true,
        chain: chain.cluster,
        mainnet: chain.cluster === 'mainnet-beta',
        payout: directPayout ? 'direct' : 'escrow',
        devEndpoints,
        // Whether transactional email can actually be delivered. Boolean only,
        // never the key or the From address.
        email: emailEnabled(),
        production: isProd,
        time: new Date().toISOString(),
      });
    }
    // SECURITY: dev conveniences (password-less /dev/login, /dev/deposit that
    // mints free balance, seeders, etc.) are DISABLED on a real chain unless
    // explicitly re-enabled. Never expose these on a public real-money deploy.
    if (!devEndpoints && (p.startsWith('/dev/') || p === '/auth/dev-login')) {
      return send(res, 404, { error: 'not found' });
    }
    try {
      // ---- static pages ----
      if (req.method === 'GET' && (p === '/' || p === '/index.html')) return serve(res, 'index.html');
      if (req.method === 'GET' && (p === '/seller' || p === '/seller.html')) return serve(res, 'seller.html');
      if (req.method === 'GET' && (p === '/admin' || p === '/admin.html')) return serve(res, 'admin.html');

      // ---- auth ----
      if (req.method === 'POST' && p === '/auth/challenge') {
        if (authRateLimited(req)) return send(res, 429, { error: 'Too many attempts. Please wait a minute.' });
        const b = await readJson(req);
        const wallet = String(b.walletAddress ?? '').trim();
        if (!isValidWalletAddress(wallet)) return send(res, 400, { error: 'Enter a valid Solana wallet address.' });
        return send(res, 200, { message: buildLoginChallenge(wallet) });
      }
      if (req.method === 'POST' && p === '/auth/verify') {
        if (authRateLimited(req)) return send(res, 429, { error: 'Too many attempts. Please wait a minute.' });
        const b = await readJson(req);
        const wallet = String(b.walletAddress ?? '').trim();
        const signature = String(b.signature ?? '').trim();
        if (!verifyWalletSignature(wallet, signature)) return send(res, 401, { error: 'bad signature' });
        const user = await findOrCreateByWallet(wallet, prisma);
        return send(res, 200, await sessionPayload(user.id));
      }
      if (req.method === 'POST' && p === '/auth/register') {
        if (authRateLimited(req)) return send(res, 429, { error: 'Too many attempts. Please wait a minute.' });
        const b = await readJson(req);
        try {
          const user = await registerWithEmail(
            { email: String(b.email ?? ''), password: String(b.password ?? ''), handle: String(b.handle ?? '') },
            prisma,
          );
          // Mail the code now; the account exists but stays unverified until it
          // comes back. A mail failure must not strand a created account, so a
          // throw here only means "no code yet": they can resend.
          await sendVerificationCode(user.id, { force: true }, prisma).catch((e) =>
            console.error('[verify] send on register failed', (e as Error)?.message ?? e),
          );
          return send(res, 200, await sessionPayload(user.id));
        } catch (err) {
          if (err instanceof AuthError) return send(res, 400, { error: err.message });
          throw err;
        }
      }
      // Confirm the emailed code. Authed: the account already exists and is
      // signed in, it just can't do anything that matters until this passes.
      /**
       * Start a password reset. Always answers 200 with the same body, whether
       * or not the address is registered: a differing response here would let
       * anyone test which emails have BIDit accounts.
       */
      if (req.method === 'POST' && p === '/auth/forgot-password') {
        if (authRateLimited(req)) return send(res, 429, { error: 'Too many attempts. Please wait a minute.' });
        const b = await readJson(req);
        await requestPasswordReset(String(b.email ?? ''), prisma).catch((e) =>
          console.error('[reset] request failed', (e as Error)?.message ?? e),
        );
        return send(res, 200, { ok: true });
      }
      if (req.method === 'POST' && p === '/auth/reset-password') {
        if (authRateLimited(req)) return send(res, 429, { error: 'Too many attempts. Please wait a minute.' });
        const b = await readJson(req);
        try {
          await resetPassword(
            { email: String(b.email ?? ''), code: String(b.code ?? ''), password: String(b.password ?? '') },
            prisma,
          );
          return send(res, 200, { ok: true });
        } catch (err) {
          if (err instanceof AuthError) return send(res, 400, { error: err.message });
          throw err;
        }
      }
      // Claim a username mid-onboarding so "that username is taken" lands on the
      // username step rather than after the whole flow.
      if (req.method === 'POST' && p === '/me/handle') {
        const userId = authUser(req);
        if (!userId) return send(res, 401, { error: 'unauthorized' });
        const b = await readJson(req);
        try {
          await setHandle(userId, String(b.handle ?? ''), prisma);
          return send(res, 200, await sessionPayload(userId));
        } catch (err) {
          if (err instanceof AuthError) return send(res, 400, { error: err.message });
          throw err;
        }
      }
      if (req.method === 'POST' && p === '/auth/verify-email') {
        const userId = authUser(req);
        if (!userId) return send(res, 401, { error: 'unauthorized' });
        if (authRateLimited(req)) return send(res, 429, { error: 'Too many attempts. Please wait a minute.' });
        const b = await readJson(req);
        try {
          await verifyEmailCode(userId, String(b.code ?? ''), prisma);
          return send(res, 200, await sessionPayload(userId));
        } catch (err) {
          if (err instanceof AuthError) return send(res, 400, { error: err.message });
          throw err;
        }
      }
      if (req.method === 'POST' && p === '/auth/resend-code') {
        const userId = authUser(req);
        if (!userId) return send(res, 401, { error: 'unauthorized' });
        if (authRateLimited(req)) return send(res, 429, { error: 'Too many attempts. Please wait a minute.' });
        try {
          await sendVerificationCode(userId, {}, prisma);
          return send(res, 200, { ok: true });
        } catch (err) {
          if (err instanceof AuthError) return send(res, 400, { error: err.message });
          throw err;
        }
      }
      if (req.method === 'POST' && p === '/auth/login') {
        if (authRateLimited(req)) return send(res, 429, { error: 'Too many attempts. Please wait a minute.' });
        const b = await readJson(req);
        const user = await loginWithEmail({ email: String(b.email ?? ''), password: String(b.password ?? '') }, prisma);
        if (!user) return send(res, 401, { error: 'Incorrect email or password.' });
        return send(res, 200, await sessionPayload(user.id));
      }
      if (req.method === 'POST' && (p === '/auth/dev-login' || p === '/dev/login')) {
        const b = await readJson(req);
        const handle = String(b.handle ?? '').trim() || `guest_${Date.now()}`;
        const user = await findOrCreateByHandle(handle, prisma);
        return send(res, 200, await sessionPayload(user.id));
      }
      if (req.method === 'PATCH' && p === '/me') {
        const userId = authUser(req);
        if (!userId) return send(res, 401, { error: 'unauthorized' });
        const b = await readJson(req);
        await updateProfile(
          userId,
          {
            displayName: typeof b.displayName === 'string' ? b.displayName : undefined,
            avatarUrl: typeof b.avatarUrl === 'string' ? b.avatarUrl : undefined,
            bio: typeof b.bio === 'string' ? b.bio : undefined,
            shippingAddress: 'shippingAddress' in b ? b.shippingAddress : undefined,
            bundleShipping: typeof b.bundleShipping === 'boolean' ? b.bundleShipping : undefined,
            shippingMode: typeof b.shippingMode === 'string' ? b.shippingMode : undefined,
          },
          prisma,
        );
        return send(res, 200, await sessionPayload(userId));
      }
      if (req.method === 'POST' && p === '/me/onboarding') {
        const userId = authUser(req);
        if (!userId) return send(res, 401, { error: 'unauthorized' });
        const b = await readJson(req);
        try {
          await completeOnboarding(
            userId,
            {
              handle: typeof b.handle === 'string' ? b.handle : undefined,
              displayName: typeof b.displayName === 'string' ? b.displayName : undefined,
              interests: Array.isArray(b.interests) ? (b.interests as string[]) : undefined,
            },
            prisma,
          );
          return send(res, 200, await sessionPayload(userId));
        } catch (err) {
          if (err instanceof AuthError) return send(res, 400, { error: err.message });
          throw err;
        }
      }

      // Log out everywhere: revoke every session token issued to this user so far
      // (this device and any other). Idempotent; safe to call when already signed out.
      if (req.method === 'POST' && p === '/auth/logout') {
        const userId = authUser(req);
        if (userId) await revokeUserSessions(userId, prisma);
        return send(res, 200, { ok: true });
      }

      // Right-to-erasure: wipe the user's personal data and disable the account.
      // Irreversible; the client should drop its token afterward (session revoked).
      if (req.method === 'POST' && p === '/me/erase') {
        const userId = authUser(req);
        if (!userId) return send(res, 401, { error: 'unauthorized' });
        await eraseUserData(userId, prisma);
        return send(res, 200, { ok: true });
      }

      // Trade the bearer session for a one-time, short-lived WebSocket ticket, so
      // the long-lived token never appears in a socket URL (which can leak via logs).
      if (req.method === 'POST' && p === '/realtime/ticket') {
        const userId = authUser(req);
        if (!userId) return send(res, 401, { error: 'unauthorized' });
        return send(res, 200, { ticket: issueWsTicket(userId) });
      }

      // ---- authenticated: me / withdraw ----
      if (req.method === 'GET' && p === '/me') {
        const userId = authUser(req);
        if (!userId) return send(res, 401, { error: 'unauthorized' });
        return send(res, 200, await sessionPayload(userId));
      }
      // NOTE: there is deliberately NO authenticated POST /deposit route. Real
      // deposits are credited ONLY by the on-chain DepositWatcher after USDC lands
      // and is swept; the mock-only simulator lives at /dev/simulate-deposit (gated
      // by devEndpoints + MockChain). A body-driven credit endpoint here would let
      // any signed-in user mint balance, so it must never exist.
      // NOTE: there is deliberately NO deposit-key export route. A deposit
      // address is plumbing, not a wallet the user should hold funds in: the
      // sweeper empties it into treasury on sight, so a key in the user's hands
      // is a footgun (they'd see a zero balance and race the sweeper) with no
      // upside. Withdrawals are the supported way to get funds out.
      if (req.method === 'POST' && p === '/withdraw') {
        const userId = authUser(req);
        if (!userId) return send(res, 401, { error: 'unauthorized' });
        await requireVerifiedEmail(userId, prisma);
        if (moneyRateLimited(userId)) return send(res, 429, { error: 'Too many requests. Please wait a minute.' });
        const b = await readJson(req);
        const toAddress = String(b.toAddress ?? '').trim();
        const amount = usdc(String(b.amount ?? '0'));
        if (!toAddress) return send(res, 400, { error: 'Enter a destination address.' });
        if (amount <= 0n) return send(res, 400, { error: 'Enter an amount greater than 0.' });
        try {
          const w = await requestWithdrawal(userId, toAddress, amount, chain, prisma);
          await realtime.notifyBalance(userId);
          const accountId = await getOrCreateUserAccount(userId, prisma);
          // A FAILED row means the transfer never went out and the debit was
          // reversed: surface it as an error (funds are back) rather than success.
          if (w.status === 'FAILED') {
            return send(res, 502, {
              error: 'The on-chain transfer could not be sent. Your balance was not charged. Try again.',
            });
          }
          return send(res, 200, {
            // CONFIRMED = landed on-chain; SUBMITTED = broadcast, confirming (the
            // reconciler finalizes it, and pushes a balance update either way).
            status: w.status,
            txSig: w.txSig,
            available: formatUsdc(await getAvailableBalance(accountId, prisma)),
          });
        } catch (err) {
          if (err instanceof WithdrawalError) return send(res, 400, { error: err.message });
          if (err instanceof InsufficientFundsError) {
            return send(res, 400, { error: 'Not enough available balance (funds in active bids are locked).' });
          }
          throw err;
        }
      }
      // Dev only: simulate a confirmed on-chain deposit so the DepositWatcher
      // detects + credits it, exactly like a real devnet transfer would.
      if (req.method === 'POST' && p === '/dev/simulate-deposit') {
        const userId = authUser(req);
        if (!userId) return send(res, 401, { error: 'unauthorized' });
        if (!(chain instanceof MockChain)) return send(res, 400, { error: 'simulation is disabled on a real chain' });
        const b = await readJson(req);
        await ensureDepositAddress(userId, chain, prisma);
        // Unique per-event signature so it never collides with a persisted
        // ledger entry from a previous run (MockChain's counter resets on restart).
        const txSig = `devdep_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        chain.simulateDeposit(userId, usdc(String(b.amount ?? '25')), txSig);
        await depositWatcher.tick(); // detect + credit now instead of waiting for the poll
        await realtime.notifyBalance(userId);
        const accountId = await getOrCreateUserAccount(userId, prisma);
        return send(res, 200, { available: formatUsdc(await getAvailableBalance(accountId, prisma)) });
      }

      // ---- notifications ----
      if (req.method === 'GET' && p === '/me/notifications') {
        const userId = authUser(req);
        if (!userId) return send(res, 401, { error: 'unauthorized' });
        return send(res, 200, await listNotifications(userId, prisma));
      }
      if (req.method === 'POST' && p === '/me/notifications/read') {
        const userId = authUser(req);
        if (!userId) return send(res, 401, { error: 'unauthorized' });
        await markAllRead(userId, prisma);
        return send(res, 200, await listNotifications(userId, prisma));
      }

      // ---- BIDit Points ----
      if (req.method === 'GET' && p === '/points') {
        const userId = authUser(req);
        if (!userId) return send(res, 401, { error: 'unauthorized' });
        const s = await getPointsSummary(userId, prisma);
        return send(res, 200, {
          points: Number(s.points),
          missions: s.missions.map((m) => ({ ...m, points: Number(m.points) })),
        });
      }
      if (req.method === 'POST' && p === '/points/claim') {
        const userId = authUser(req);
        if (!userId) return send(res, 401, { error: 'unauthorized' });
        const b = await readJson(req);
        try {
          const r = await claimMission(userId, String(b.missionId ?? ''), prisma);
          return send(res, 200, { points: Number(r.points), total: Number(r.total) });
        } catch (err) {
          if (err instanceof PointsError) return send(res, 400, { error: err.message });
          throw err;
        }
      }
      if (req.method === 'GET' && p === '/points/leaderboard') {
        const rows = await getLeaderboard(25, prisma);
        return send(res, 200, rows.map((r) => ({ ...r, points: Number(r.points) })));
      }

      // ---- fulfillment (buyer) ----
      if (req.method === 'GET' && p === '/me/fulfillment') {
        const userId = authUser(req);
        if (!userId) return send(res, 401, { error: 'unauthorized' });
        return send(res, 200, await buyerFulfillmentDto(userId));
      }
      if (req.method === 'GET' && p === '/me/purchases') {
        const userId = authUser(req);
        if (!userId) return send(res, 401, { error: 'unauthorized' });
        return send(res, 200, await buyerPurchasesDto(userId));
      }
      if (req.method === 'POST' && p === '/shipping/quote-listing') {
        const userId = authUser(req);
        if (!userId) return send(res, 401, { error: 'unauthorized' });
        const b = await readJson(req);
        try {
          const est = await estimateListingShipping(userId, String(b.listingId ?? ''), prisma);
          return send(res, 200, {
            shippingFee: formatUsdc(est.shippingFee),
            privacyFee: formatUsdc(est.privacyFee),
            hasAddress: est.hasAddress,
            isFrom: est.isFrom,
          });
        } catch (err) {
          if (err instanceof ShippingError) return send(res, 400, { error: err.message });
          throw err;
        }
      }
      if (req.method === 'POST' && p === '/shipments/estimate') {
        const userId = authUser(req);
        if (!userId) return send(res, 401, { error: 'unauthorized' });
        const b = await readJson(req);
        const itemIds = Array.isArray(b.itemIds) ? (b.itemIds as unknown[]).map(String) : [];
        // Every call here can hit a carrier API, so it is metered like the other
        // money endpoints rather than left open to a refresh loop.
        if (moneyRateLimited(userId)) return send(res, 429, { error: 'Too many requests. Please wait a minute.' });
        try {
          const est = await estimateShipment(
            { buyerId: userId, itemIds, private: b.private === true },
            systemClock,
            prisma,
          );
          return send(res, 200, {
            quoteId: est.quoteId,
            shippingFee: formatUsdc(est.shippingFee),
            privacyFee: formatUsdc(est.privacyFee),
            total: formatUsdc(est.total),
            carrier: est.carrier,
            service: est.service,
            estDays: est.estDays,
            hasAddress: est.hasAddress,
          });
        } catch (err) {
          if (err instanceof ShippingError) return send(res, 400, { error: err.message });
          throw err;
        }
      }
      if (req.method === 'POST' && p === '/shipments') {
        const userId = authUser(req);
        if (!userId) return send(res, 401, { error: 'unauthorized' });
        const b = await readJson(req);
        const itemIds = Array.isArray(b.itemIds) ? (b.itemIds as unknown[]).map(String) : [];
        if (moneyRateLimited(userId)) return send(res, 429, { error: 'Too many requests. Please wait a minute.' });
        try {
          const shipment = await createAndPayShipment(
            {
              buyerId: userId,
              itemIds,
              mode: b.mode as ShipMode | undefined,
              private: b.private === true,
              quoteId: b.quoteId ? String(b.quoteId) : undefined,
            },
            systemClock,
            prisma,
          );
          await realtime.notifyBalance(userId);
          return send(res, 200, await shipmentDto(shipment.id));
        } catch (err) {
          if (err instanceof ShippingError) return send(res, 400, { error: err.message });
          // 409, not 400: the request was well formed, the price just moved. The
          // client re-estimates and shows the buyer the new number to confirm.
          if (err instanceof QuoteStaleError) return send(res, 409, { error: err.message, code: 'QUOTE_STALE' });
          if (err instanceof InsufficientFundsError) {
            return send(res, 400, { error: 'Not enough balance to cover shipping.' });
          }
          throw err;
        }
      }
      if (req.method === 'POST' && p === '/shipment/discard') {
        const userId = authUser(req);
        if (!userId) return send(res, 401, { error: 'unauthorized' });
        const b = await readJson(req);
        try {
          // Forfeit: releases the escrow to the seller when the price is still locked.
          await buyerDiscardItem(String(b.itemId ?? ''), userId, escrow, systemClock, prisma);
          return send(res, 200, await buyerFulfillmentDto(userId));
        } catch (err) {
          if (err instanceof ShippingError) return send(res, 400, { error: err.message });
          throw err;
        }
      }
      if (req.method === 'POST' && p === '/shipment/confirm-received') {
        const userId = authUser(req);
        if (!userId) return send(res, 401, { error: 'unauthorized' });
        const b = await readJson(req);
        const s = await prisma.shipment.findUnique({ where: { id: String(b.shipmentId ?? '') } });
        if (!s || s.buyerId !== userId) return send(res, 404, { error: 'Shipment not found.' });
        try {
          await markShipmentDelivered(s.id, systemClock, prisma);
          // Delivered → open the 2-day dispute window on the linked order(s).
          await advanceOrdersForShipment(s.id, 'DISPUTE_WINDOW', systemClock, prisma);
          return send(res, 200, await buyerFulfillmentDto(userId));
        } catch (err) {
          if (err instanceof ShippingError) return send(res, 400, { error: err.message });
          throw err;
        }
      }
      // Buyer reports a problem with a delivered package (reason + detail + photos).
      if (req.method === 'POST' && p === '/shipment/dispute') {
        const userId = authUser(req);
        if (!userId) return send(res, 401, { error: 'unauthorized' });
        const b = await readJson(req);
        const reason = String(b.reason ?? '').trim();
        const detail = String(b.detail ?? '').trim();
        const photos = Array.isArray(b.photos) ? b.photos.filter((x: unknown) => typeof x === 'string').slice(0, 6) : [];
        if (!reason) return send(res, 400, { error: 'Pick what went wrong.' });
        if (!detail) return send(res, 400, { error: 'Add a short description of the problem.' });
        try {
          await disputeShipment(String(b.shipmentId ?? ''), userId, { reason, detail, photos }, systemClock, prisma);
          return send(res, 200, await buyerFulfillmentDto(userId));
        } catch (err) {
          return send(res, 400, { error: err instanceof Error ? err.message : 'Could not open the dispute.' });
        }
      }

      // ---- seller ----
      if (req.method === 'POST' && p === '/seller/apply') {
        const userId = authUser(req);
        if (!userId) return send(res, 401, { error: 'unauthorized' });
        await requireVerifiedEmail(userId, prisma);
        await applyAsSeller(userId, prisma);
        return send(res, 200, await sessionPayload(userId));
      }
      if (req.method === 'POST' && p === '/seller/onboarding') {
        const userId = authUser(req);
        if (!userId) return send(res, 401, { error: 'unauthorized' });
        // You must already BE a seller to fill in seller details. Without this the
        // route was a second way to skip /seller/apply and its email verification.
        await requireSeller(userId, prisma);
        const b = await readJson(req);
        // Coin linking goes through the guarded setter FIRST (first-claim-wins):
        // hijacking another seller's coin 409s here, before anything is marked
        // onboarded. An absent/empty coinAddress never touches the link: an
        // auto-created coin from the create flow must survive finishing the wizard.
        if (typeof b.coinAddress === 'string' && b.coinAddress.trim()) {
          await setSellerCoin(userId, b.coinAddress.trim(), prisma);
        }
        await submitSellerOnboarding(
          userId,
          {
            website: typeof b.website === 'string' ? b.website : undefined,
            socials: b.socials && typeof b.socials === 'object' ? (b.socials as Record<string, string>) : undefined,
            pitch: typeof b.pitch === 'string' ? b.pitch : undefined,
            origin:
              b.origin && typeof b.origin === 'object'
                ? (b.origin as { country?: string; region?: string; city?: string; postal?: string })
                : undefined,
          },
          prisma,
        );
        return send(res, 200, await sessionPayload(userId));
      }
      if (req.method === 'GET' && p === '/seller/orders') {
        const userId = authUser(req);
        if (!userId) return send(res, 401, { error: 'unauthorized' });
        return send(res, 200, await sellerOrdersDto(userId));
      }
      // Public: launch "$100 to sell" promo state (drives the homepage banner).
      if (req.method === 'GET' && p === '/promo') {
        return send(res, 200, promoState());
      }
      // This seller's promo progress ($ fulfilled toward the $100 bonus).
      if (req.method === 'GET' && p === '/seller/promo') {
        const userId = authUser(req);
        if (!userId) return send(res, 401, { error: 'unauthorized' });
        return send(res, 200, await sellerPromoStatus(userId, prisma));
      }
      if (req.method === 'POST' && p === '/seller/coin') {
        const userId = authUser(req);
        if (!userId) return send(res, 401, { error: 'unauthorized' });
        await requireSeller(userId, prisma);
        const b = await readJson(req);
        await setSellerCoin(userId, String(b.coinAddress ?? '').trim(), prisma);
        return send(res, 200, { ok: true });
      }
      // ---- seller coin auto-create ("<handle>'s BIDit Livestream") ----------
      // The seller's wallet is the creator either way, because pump.fun only
      // grants THEM the livestream button. prepare: hand back whatever the
      // wallet must sign (a pump.fun sign-in message by default; a create tx on
      // the on-chain escape hatch). submit: verify it and create the coin.
      if (req.method === 'POST' && p === '/seller/coin-create/prepare') {
        const userId = authUser(req);
        if (!userId) return send(res, 401, { error: 'unauthorized' });
        await requireSeller(userId, prisma);
        if (coinCreateRateLimited(userId)) {
          return send(res, 429, { error: 'Too many coin-create attempts. Give it a few minutes.' });
        }
        const b = await readJson(req);
        const mockMode = pumpCreate.mode === 'mock' || pumpCreate.mode === 'mock-offchain';
        let creatorWallet: string | null = null;
        if (!mockMode) {
          const w = String(b.creatorWallet ?? '').trim();
          if (!w || !chain.isValidAddress(w)) {
            return send(res, 400, { error: 'Connect a Solana wallet to create your coin.', code: 'BAD_WALLET' });
          }
          creatorWallet = w;
        }
        const { attempt, messageB58, loginMessage, signMode } = await prepareCoinCreate(
          userId,
          creatorWallet,
          pumpCreate,
          prisma,
        );
        return send(res, 200, {
          attemptId: attempt.id,
          mint: attempt.mint,
          mode: pumpCreate.mode,
          signMode,
          // The full mint-signed tx (base64): Phantom's object-form signTransaction
          // needs it: the b58 message lane can't represent versioned (v0) txs.
          txB64: attempt.txB64,
          message: messageB58,
          // Plain text for signMode 'message': shown verbatim in the wallet.
          loginMessage,
          name: attempt.name,
          symbol: attempt.symbol,
        });
      }
      if (req.method === 'POST' && p === '/seller/coin-create/submit') {
        const userId = authUser(req);
        if (!userId) return send(res, 401, { error: 'unauthorized' });
        await requireSeller(userId, prisma);
        if (moneyRateLimited(userId)) return send(res, 429, { error: 'Slow down a moment.' });
        const b = await readJson(req);
        // Three shapes, one per signing lane: pump.fun sign-in signature
        // (default, base64), a whole signed tx, or a raw tx-message signature.
        const proof =
          typeof b.publicKey === 'string' && b.publicKey && typeof b.loginSignature === 'string' && b.loginSignature
            ? { publicKey: b.publicKey, signatureB64: b.loginSignature }
            : typeof b.signedTxB64 === 'string' && b.signedTxB64
              ? { signedTxB64: b.signedTxB64 }
              : typeof b.publicKey === 'string' && b.publicKey && typeof b.signature === 'string' && b.signature
                ? { publicKey: b.publicKey, signatureB58: b.signature }
                : null;
        const dto = await submitCoinCreate(userId, String(b.attemptId ?? ''), proof, pumpCreate, prisma);
        return send(res, 200, dto);
      }
      if (req.method === 'GET' && p === '/seller/coin-create/status') {
        const userId = authUser(req);
        if (!userId) return send(res, 401, { error: 'unauthorized' });
        await requireSeller(userId, prisma);
        return send(res, 200, await getCoinCreateStatus(userId, pumpCreate, prisma));
      }
      // Livestream identity: a custom stream title (shown on the live cards instead
      // of the coin name) and the category tag for the stream.
      if (req.method === 'POST' && p === '/seller/stream-settings') {
        const userId = authUser(req);
        if (!userId) return send(res, 401, { error: 'unauthorized' });
        await requireSeller(userId, prisma);
        const b = await readJson(req);
        const clip = (v: unknown, max: number) =>
          typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null;
        // Chat cooldown: only an allowed value is accepted (off / 3 / 5 / 10 / 30s);
        // anything else leaves it unchanged (undefined → not written).
        const ALLOWED_COOLDOWNS = [0, 3000, 5000, 10000, 30000];
        const cd = Number(b.chatCooldownMs);
        const chatCooldownMs = ALLOWED_COOLDOWNS.includes(cd) ? cd : undefined;
        // Cover art rides in the JSON as a downscaled data URL. Accept only an
        // inline image (never a remote URL we'd re-serve) and cap it: every /live
        // row carries this string, so an oversized one would bloat the grid for
        // everyone. The client downscales to ~720px, well inside this.
        const streamImage = ((): string | null => {
          const v = b.streamImage;
          if (typeof v !== 'string' || !v.trim()) return null;
          if (!/^data:image\/(png|jpeg|webp);base64,/.test(v)) return null;
          return v.length > 600_000 ? null : v;
        })();
        const data = {
          streamTitle: clip(b.streamTitle, 80),
          streamCategory: clip(b.streamCategory, 40),
          streamImage,
          ...(chatCooldownMs !== undefined ? { chatCooldownMs } : {}),
        };
        await prisma.sellerProfile.upsert({
          where: { userId },
          update: data,
          create: { userId, ...data },
        });
        return send(res, 200, await sessionPayload(userId));
      }
      // ---- chat moderators (owner manages; moderators just use the powers) ----
      if (req.method === 'GET' && p === '/seller/moderators') {
        const userId = authUser(req);
        if (!userId) return send(res, 401, { error: 'unauthorized' });
        await requireSeller(userId, prisma);
        const mods = await listRoomModerators(userId, prisma);
        return send(res, 200, mods.map((m) => ({ ...m, addedAt: m.addedAt.getTime() })));
      }
      if (req.method === 'POST' && p === '/seller/moderators') {
        const userId = authUser(req);
        if (!userId) return send(res, 401, { error: 'unauthorized' });
        await requireSeller(userId, prisma);
        const b = await readJson(req);
        const added = await addRoomModerator(userId, String(b.handle ?? ''), prisma);
        return send(res, 200, added);
      }
      if (req.method === 'POST' && p === '/seller/moderators/remove') {
        const userId = authUser(req);
        if (!userId) return send(res, 401, { error: 'unauthorized' });
        await requireSeller(userId, prisma);
        const b = await readJson(req);
        await removeRoomModerator(userId, String(b.userId ?? ''), prisma);
        return send(res, 200, { ok: true });
      }
      /** Set a room's chat cooldown. Open to the seller AND their moderators:
       *  slowing a spammy chat is a moderation action, not a shop setting. */
      if (req.method === 'POST' && p === '/room/chat-cooldown') {
        const userId = authUser(req);
        if (!userId) return send(res, 401, { error: 'unauthorized' });
        const b = await readJson(req);
        const room = String(b.room ?? '');
        if (!(await canModerateRoom(room, userId, prisma))) {
          return send(res, 403, { error: 'You can’t moderate this room.' });
        }
        const ALLOWED = [0, 3000, 5000, 10000, 30000];
        const cd = Number(b.chatCooldownMs);
        if (!ALLOWED.includes(cd)) return send(res, 400, { error: 'Pick one of the offered cooldowns.' });
        // UPDATE ONLY, never upsert. canModerateRoom is true for your own id, and
        // "has a SellerProfile" IS what requireSeller means, so an upsert here let
        // any account mint itself the seller role and skip /seller/apply's email
        // verification, landing with appliedAt null so admin never saw it.
        const touched = await prisma.sellerProfile.updateMany({
          where: { userId: room },
          data: { chatCooldownMs: cd },
        });
        if (touched.count === 0) return send(res, 404, { error: 'That room has no seller profile.' });
        return send(res, 200, { ok: true, chatCooldownMs: cd });
      }
      if (req.method === 'POST' && p === '/seller/shipping-settings') {
        const userId = authUser(req);
        if (!userId) return send(res, 401, { error: 'unauthorized' });
        await requireSeller(userId, prisma);
        const b = await readJson(req);
        const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
        const data = {
          originName: str(b.originName),
          originLine1: str(b.originLine1),
          originLine2: str(b.originLine2),
          originCountry: str(b.originCountry),
          originRegion: str(b.originRegion),
          originCity: str(b.originCity),
          originPostal: str(b.originPostal),
          weeklyBundling: b.weeklyBundling === true,
          shipLater: b.shipLater === true,
          privateShipping: b.privateShipping === true,
        };
        await prisma.sellerProfile.upsert({
          where: { userId },
          update: data,
          create: { userId, ...data },
        });
        return send(res, 200, await sessionPayload(userId));
      }
      if (req.method === 'GET' && p === '/seller/shipments') {
        const userId = authUser(req);
        if (!userId) return send(res, 401, { error: 'unauthorized' });
        const shipments = await getSellerShipments(userId, prisma);
        return send(res, 200, await Promise.all(shipments.map((s) => shipmentDto(s.id, { forSeller: true }))));
      }
      if (req.method === 'GET' && p === '/seller/held') {
        const userId = authUser(req);
        if (!userId) return send(res, 401, { error: 'unauthorized' });
        const held = await getSellerHeldItems(userId, prisma);
        const handles = new Map<string, string | null>();
        for (const it of held) {
          if (!handles.has(it.buyerId)) {
            const u = await prisma.user.findUnique({ where: { id: it.buyerId }, select: { handle: true } });
            handles.set(it.buyerId, u?.handle ?? null);
          }
        }
        return send(res, 200, held.map((it) => ({
          id: it.id,
          title: it.title,
          image: it.photo,
          buyerHandle: handles.get(it.buyerId) ?? null,
          heldUntil: it.heldUntil ? it.heldUntil.getTime() : null,
        })));
      }
      // Seller clears a held win whose 14-day hold expired with shipping unpaid.
      // Forfeit: the seller keeps the item, and locked escrow releases to them.
      if (req.method === 'POST' && p === '/seller/held/discard') {
        const userId = authUser(req);
        if (!userId) return send(res, 401, { error: 'unauthorized' });
        const b = await readJson(req);
        try {
          await sellerDiscardExpiredItem(String(b.itemId ?? ''), userId, escrow, systemClock, prisma);
          return send(res, 200, { ok: true });
        } catch (err) {
          if (err instanceof ShippingError) return send(res, 400, { error: err.message });
          throw err;
        }
      }
      // Seller confirms the package size for a PAID shipment → BIDit makes the label.
      if (req.method === 'POST' && p === '/seller/shipment/confirm-label') {
        const userId = authUser(req);
        if (!userId) return send(res, 401, { error: 'unauthorized' });
        const b = await readJson(req);
        try {
          await confirmShipmentForLabel(
            {
              shipmentId: String(b.shipmentId ?? ''),
              sellerId: userId,
              lengthCm: Number(b.lengthCm),
              widthCm: Number(b.widthCm),
              heightCm: Number(b.heightCm),
              weightGrams: Number(b.weightGrams),
            },
            systemClock,
            prisma,
          );
          return send(res, 200, await shipmentDto(String(b.shipmentId ?? ''), { forSeller: true }));
        } catch (err) {
          if (err instanceof ShippingError) return send(res, 400, { error: err.message });
          throw err;
        }
      }
      // NOTE: sellers do NOT mark a package shipped. Once they drop the BIDit label
      // at the carrier, the carrier's first scan flips it to SHIPPED (ShipmentTracker),
      // and delivery is detected the same way, with an admin override under /admin.
      if (req.method === 'GET' && p === '/seller/listings') {
        const userId = authUser(req);
        if (!userId) return send(res, 401, { error: 'unauthorized' });
        const listings = await listSellerListings(userId, prisma);
        return send(res, 200, listings.map(listingDto));
      }
      if (req.method === 'POST' && p === '/seller/listings') {
        const userId = authUser(req);
        if (!userId) return send(res, 401, { error: 'unauthorized' });
        const b = await readJson(req);
        const listing = await createListing(
          userId,
          {
            title: String(b.title ?? 'Untitled'),
            description: b.description ? String(b.description) : undefined,
            photos: typeof b.imageUrl === 'string' && b.imageUrl ? [b.imageUrl] : [],
            startingBid: usdc(String(b.startingBid ?? '1')),
            buyNowPrice: b.buyNowPrice != null && String(b.buyNowPrice).trim() !== '' ? usdc(String(b.buyNowPrice)) : undefined,
            quantity: b.quantity ? Number(b.quantity) : undefined,
            weightGrams: b.weightGrams ? Number(b.weightGrams) : undefined,
            // The preset id is the only thing trusted here: createListing resolves
            // it against the preset table, so `parcel` is read for 'custom' only.
            parcelPreset: b.parcelPreset ? String(b.parcelPreset) : undefined,
            parcel:
              b.parcel && typeof b.parcel === 'object'
                ? {
                    lengthMm: Number((b.parcel as Record<string, unknown>).lengthMm),
                    widthMm: Number((b.parcel as Record<string, unknown>).widthMm),
                    heightMm: Number((b.parcel as Record<string, unknown>).heightMm),
                  }
                : undefined,
            category: b.category ? String(b.category) : undefined,
          },
          prisma,
        );
        return send(res, 200, listingDto(listing));
      }
      // Set or clear (null) the store buy-now price on an existing listing.
      if (req.method === 'POST' && p === '/seller/listing/store-price') {
        const userId = authUser(req);
        if (!userId) return send(res, 401, { error: 'unauthorized' });
        const b = await readJson(req);
        const price = b.buyNowPrice != null && String(b.buyNowPrice).trim() !== '' ? usdc(String(b.buyNowPrice)) : null;
        const listing = await setListingStorePrice(userId, String(b.listingId ?? ''), price, prisma);
        return send(res, 200, listingDto(listing));
      }
      if (req.method === 'POST' && p === '/seller/listing/wheel') {
        const userId = authUser(req);
        if (!userId) return send(res, 401, { error: 'unauthorized' });
        const b = await readJson(req);
        try {
          const entries = await setListingWheel(userId, String(b.listingId), b.entries, prisma);
          return send(res, 200, { ok: true, count: entries.length, entries });
        } catch (err) {
          return send(res, 400, { error: err instanceof Error ? err.message : 'bad request' });
        }
      }
      if (req.method === 'POST' && p === '/seller/start-auction') {
        const userId = authUser(req);
        if (!userId) return send(res, 401, { error: 'unauthorized' });
        const b = await readJson(req);
        const listing = await prisma.listing.findUnique({ where: { id: String(b.listingId) } });
        if (!listing || listing.sellerId !== userId) return send(res, 403, { error: 'not your listing' });
        const result = await startAuctionFromListing(
          String(b.listingId),
          {
            durationSeconds: b.durationSeconds ? Number(b.durationSeconds) : undefined,
            counterBidSeconds: b.counterBidSeconds ? Number(b.counterBidSeconds) : undefined,
          },
          systemClock,
          prisma,
        );
        await realtime.announceAuction(result.auctionId);
        return send(res, 200, result);
      }
      if (req.method === 'POST' && p === '/seller/giveaway') {
        const userId = authUser(req);
        if (!userId) return send(res, 401, { error: 'unauthorized' });
        await requireSeller(userId, prisma);
        const b = await readJson(req);
        try {
          const durationMs = b.durationSeconds ? Number(b.durationSeconds) * 1000 : undefined;
          const g = await openGiveaway(
            userId,
            {
              kind: b.kind === 'BUYER_ONLY' ? 'BUYER_ONLY' : 'PUBLIC',
              prize: String(b.prize ?? ''),
              image: typeof b.image === 'string' && b.image ? String(b.image) : null,
              durationMs,
            },
            systemClock,
            prisma,
          );
          await realtime.announceGiveaway(g.id);
          return send(res, 200, giveawayDto(g));
        } catch (err) {
          return send(res, 400, { error: err instanceof Error ? err.message : 'bad request' });
        }
      }
      if (req.method === 'GET' && p === '/seller/giveaway') {
        const userId = authUser(req);
        if (!userId) return send(res, 401, { error: 'unauthorized' });
        const g = await getOpenGiveaway(userId, prisma);
        return send(res, 200, g ? giveawayDto(g) : null);
      }
      if (req.method === 'POST' && p === '/seller/giveaway/draw') {
        const userId = authUser(req);
        if (!userId) return send(res, 401, { error: 'unauthorized' });
        const b = await readJson(req);
        const g = await prisma.giveaway.findUnique({ where: { id: String(b.giveawayId ?? '') } });
        if (!g || g.sellerId !== userId) return send(res, 403, { error: 'not your giveaway' });
        const result = await realtime.drawGiveawayAndBroadcast(g.id);
        if (!result.ok) return send(res, 400, { error: 'No entrants yet.' });
        return send(res, 200, {
          ok: true,
          winnerHandle: result.winner.handle,
          entrantCount: result.entrants.length,
        });
      }
      // NOTE: no seller-facing order ship/deliver endpoints. Sellers never mark an
      // order shipped/delivered or enter a tracking number: the admin creates the
      // label + tracking and the carrier tracker (or admin override) drives status.

      // ---- admin ----
      if (req.method === 'GET' && p === '/admin/sellers') {
        const userId = authUser(req);
        if (!userId) return send(res, 401, { error: 'unauthorized' });
        return send(res, 200, await listSellers(userId, prisma));
      }
      // Admin: enrolled sellers + $ fulfilled, so you know who to pay the $100.
      // Admin: find an account to act on. Matches handle or email, so support
      // can work from whatever the reporter gave them.
      if (req.method === 'GET' && p === '/admin/users') {
        const userId = authUser(req);
        if (!userId) return send(res, 401, { error: 'unauthorized' });
        if (!(await isAdmin(userId, prisma))) return send(res, 403, { error: 'admin required' });
        const q = String(url.searchParams.get('q') ?? '').trim().slice(0, 80);
        const rows = await prisma.user.findMany({
          where: q
            ? { OR: [{ handle: { contains: q, mode: 'insensitive' } }, { email: { contains: q, mode: 'insensitive' } }] }
            : { bannedAt: { not: null } }, // no query: show who is currently banned
          select: {
            id: true, handle: true, email: true, role: true, emailVerified: true,
            bannedAt: true, bannedReason: true, createdAt: true,
          },
          orderBy: { createdAt: 'desc' },
          take: 25,
        });
        return send(res, 200, rows.map((u) => ({
          ...u,
          bannedAt: u.bannedAt ? u.bannedAt.getTime() : null,
          createdAt: u.createdAt.getTime(),
        })));
      }
      // Admin: suspend an account. Reversible and non-destructive (see banUser).
      if (req.method === 'POST' && p === '/admin/ban') {
        const userId = authUser(req);
        if (!userId) return send(res, 401, { error: 'unauthorized' });
        if (!(await isAdmin(userId, prisma))) return send(res, 403, { error: 'admin required' });
        const b = await readJson(req);
        const target = String(b.userId ?? '');
        if (target === userId) return send(res, 400, { error: 'You cannot ban yourself.' });
        await banUser(target, b.reason == null ? null : String(b.reason), prisma);
        // Cut their live sockets now rather than waiting for the next heartbeat.
        realtime.closeUserSockets(target);
        console.log(`[admin] ${userId} banned ${target}`);
        return send(res, 200, { ok: true });
      }
      if (req.method === 'POST' && p === '/admin/unban') {
        const userId = authUser(req);
        if (!userId) return send(res, 401, { error: 'unauthorized' });
        if (!(await isAdmin(userId, prisma))) return send(res, 403, { error: 'admin required' });
        const b = await readJson(req);
        await unbanUser(String(b.userId ?? ''), prisma);
        console.log(`[admin] ${userId} unbanned ${String(b.userId ?? '')}`);
        return send(res, 200, { ok: true });
      }
      if (req.method === 'GET' && p === '/admin/promo') {
        const userId = authUser(req);
        if (!userId) return send(res, 401, { error: 'unauthorized' });
        if (!(await isAdmin(userId, prisma))) return send(res, 403, { error: 'admin required' });
        return send(res, 200, await listPromoSellers(prisma));
      }
      // Admin: mark a seller's $100 bonus as paid (records it; moves no funds).
      if (req.method === 'POST' && p === '/admin/promo/mark-paid') {
        const userId = authUser(req);
        if (!userId) return send(res, 401, { error: 'unauthorized' });
        if (!(await isAdmin(userId, prisma))) return send(res, 403, { error: 'admin required' });
        const b = await readJson(req);
        await markPromoPaid(String(b.sellerUserId), prisma);
        return send(res, 200, { ok: true });
      }
      if (req.method === 'POST' && p === '/admin/verify-seller') {
        const userId = authUser(req);
        if (!userId) return send(res, 401, { error: 'unauthorized' });
        const b = await readJson(req);
        await verifySeller(userId, String(b.sellerUserId), prisma);
        return send(res, 200, { ok: true });
      }
      // Admin: force-move a pump.fun coin to a seller. The ONLY way a claimed coin
      // changes hands: sellers self-serve is first-claim-wins (see setSellerCoin).
      if (req.method === 'POST' && p === '/admin/seller-coin') {
        const userId = authUser(req);
        if (!userId) return send(res, 401, { error: 'unauthorized' });
        if (!(await isAdmin(userId, prisma))) return send(res, 403, { error: 'admin required' });
        const b = await readJson(req);
        await reassignCoin(String(b.sellerUserId ?? ''), String(b.coinAddress ?? '').trim(), prisma);
        return send(res, 200, { ok: true });
      }
      if (req.method === 'GET' && p === '/admin/audit') {
        const userId = authUser(req);
        if (!userId) return send(res, 401, { error: 'unauthorized' });
        return send(res, 200, await ledgerAudit(userId, prisma));
      }
      // Wallet ↔ ledger reconciliation (hits the chain 4×): the pre-flip + ongoing
      // escrow safety check. Every wallet should equal its ledger account.
      if (req.method === 'GET' && p === '/admin/wallet-audit') {
        const userId = authUser(req);
        if (!userId) return send(res, 401, { error: 'unauthorized' });
        if (!(await isAdmin(userId, prisma))) return send(res, 403, { error: 'admin required' });
        const recon = await reconcileWallets(chain, prisma);
        return send(res, 200, {
          cluster: chain.cluster,
          pendingLegs: recon.pendingLegs,
          reconciled: recon.reconciled,
          rows: recon.rows.map((r) => ({ wallet: r.wallet, chain: formatUsdc(r.chain), ledger: formatUsdc(r.ledger), diff: formatUsdc(r.diff) })),
        });
      }
      // Operator-only: Private Secure Shipping reship queue. Exposes each buyer's
      // REAL address (privateLeg2) (never shown to sellers) so the operator can
      // ship the hub→buyer leg.
      if (req.method === 'GET' && p === '/admin/private-shipments') {
        const userId = authUser(req);
        if (!userId) return send(res, 401, { error: 'unauthorized' });
        // isAdmin() (role OR BIDIT_ADMIN_EMAILS): consistent with every other admin
        // route; a direct role check locked allowlist operators out of this PII view.
        if (!(await isAdmin(userId, prisma))) return send(res, 403, { error: 'admin required' });
        const shipments = await listPrivateShipments(prisma);
        const out = await Promise.all(
          shipments.map(async (s) => {
            const [items, buyer, seller] = await Promise.all([
              shipmentItems(s.id, prisma),
              prisma.user.findUnique({ where: { id: s.buyerId }, select: { handle: true } }),
              prisma.user.findUnique({ where: { id: s.sellerId }, select: { handle: true } }),
            ]);
            return {
              id: s.id,
              status: s.status,
              buyerHandle: buyer?.handle ?? null,
              sellerHandle: seller?.handle ?? null,
              privacyFee: formatUsdc(s.privacyFee),
              buyerRealAddress: decryptPii(s.privateLeg2), // operator-only
              trackingNumber: s.trackingNumber,
              carrier: s.carrier,
              items: items.map((it) => ({ id: it.id, title: it.title })),
              createdAt: s.createdAt.getTime(),
            };
          }),
        );
        return send(res, 200, out);
      }
      // Shippo readiness probe. Rating is free and read-only (this buys nothing),
      // so it is safe to run against production, and it is the only way to answer
      // the question the rate system rests on: does this Shippo account return
      // rates for the lanes we actually sell on? A Canadian origin with no
      // Canadian carrier account returns ZERO rates, and no amount of caching or
      // fallback logic fixes that. Override the origin with ?country=&region=
      // &city=&postal=; otherwise it probes a real seller's ship-from.
      if (req.method === 'GET' && p === '/admin/shipping/diagnose') {
        const userId = authUser(req);
        if (!userId) return send(res, 401, { error: 'unauthorized' });
        if (!(await isAdmin(userId, prisma))) return send(res, 403, { error: 'admin required' });
        const q = url.searchParams;
        let origin: ShippoAddress | null = null;
        if (q.get('country')) {
          origin = {
            city: q.get('city') ?? undefined,
            state: q.get('region') ?? undefined,
            zip: q.get('postal') ?? undefined,
            country: String(q.get('country')),
          };
        } else {
          // Prefer the caller's own ship-from, then any seller who has one, so the
          // probe reflects a lane that really exists rather than a guess.
          const profile =
            (await prisma.sellerProfile.findFirst({
              where: { userId, originCountry: { not: null }, originPostal: { not: null } },
            })) ??
            (await prisma.sellerProfile.findFirst({
              where: { originCountry: { not: null }, originPostal: { not: null } },
              orderBy: { createdAt: 'asc' },
            }));
          origin = profile
            ? {
                city: profile.originCity ?? undefined,
                state: profile.originRegion ?? undefined,
                zip: profile.originPostal ?? undefined,
                country: profile.originCountry!,
              }
            : { city: 'Calgary', state: 'AB', zip: 'T2P 1J9', country: 'CA' };
        }
        return send(res, 200, { origin, ...(await diagnoseShipping(origin)) });
      }
      // Operator label queue: every package a seller has confirmed that needs a
      // label made. Includes items, package size, both parties' addresses, and the
      // shipping the buyer paid: everything needed to buy the carrier label.
      if (req.method === 'GET' && p === '/admin/label-queue') {
        const userId = authUser(req);
        if (!userId) return send(res, 401, { error: 'unauthorized' });
        if (!(await isAdmin(userId, prisma))) return send(res, 403, { error: 'admin required' });
        const queue = await listLabelQueue(prisma);
        const out = await Promise.all(
          queue.map(async (s) => {
            const [items, seller, buyer, sellerProfile] = await Promise.all([
              shipmentItems(s.id, prisma),
              prisma.user.findUnique({ where: { id: s.sellerId }, select: { handle: true, displayName: true } }),
              prisma.user.findUnique({ where: { id: s.buyerId }, select: { handle: true } }),
              prisma.sellerProfile.findUnique({
                where: { userId: s.sellerId },
                select: { originCity: true, originRegion: true, originPostal: true, originCountry: true },
              }),
            ]);
            return {
              id: s.id,
              mode: s.mode,
              shippingPaid: formatUsdc(s.shippingFee + s.privacyFee),
              dims: { lengthCm: s.lengthCm, widthCm: s.widthCm, heightCm: s.heightCm, weightGrams: s.packageWeightG },
              seller: { handle: seller?.handle ?? null, name: seller?.displayName ?? null, origin: sellerProfile },
              // Address BIDit ships to (buyer's real address, or the hub for Private).
              buyer: { handle: buyer?.handle ?? null, address: decryptPii(s.shipTo) },
              items: items.map((it) => ({ id: it.id, title: it.title, image: it.photo })),
              confirmedAt: s.confirmedAt ? s.confirmedAt.getTime() : null,
            };
          }),
        );
        return send(res, 200, out);
      }
      // Operator attaches a generated label + tracking to a confirmed package.
      // LABEL_PENDING -> LABEL_CREATED (emails the seller it's ready to print).
      if (req.method === 'POST' && p === '/admin/shipment/label') {
        const userId = authUser(req);
        if (!userId) return send(res, 401, { error: 'unauthorized' });
        if (!(await isAdmin(userId, prisma))) return send(res, 403, { error: 'admin required' });
        const b = await readJson(req);
        try {
          await createShipmentLabel(
            {
              shipmentId: String(b.shipmentId ?? ''),
              labelUrl: String(b.labelUrl ?? ''),
              trackingNumber: String(b.trackingNumber ?? ''),
              carrier: b.carrier ? String(b.carrier) : undefined,
            },
            systemClock,
            prisma,
          );
          return send(res, 200, await shipmentDto(String(b.shipmentId ?? '')));
        } catch (err) {
          if (err instanceof ShippingError) return send(res, 400, { error: err.message });
          throw err;
        }
      }
      // Operator TEST controls: drive the pipeline by hand (Shippo normally does
      // this). List in-flight packages + step them shipped → delivered → released.
      if (req.method === 'GET' && p === '/admin/shipments/inflight') {
        const userId = authUser(req);
        if (!userId) return send(res, 401, { error: 'unauthorized' });
        if (!(await isAdmin(userId, prisma))) return send(res, 403, { error: 'admin required' });
        const inflight = await listInflightShipments(prisma);
        const out = await Promise.all(
          inflight.map(async (s) => {
            const [items, buyer, seller, fitems] = await Promise.all([
              shipmentItems(s.id, prisma),
              prisma.user.findUnique({ where: { id: s.buyerId }, select: { handle: true } }),
              prisma.user.findUnique({ where: { id: s.sellerId }, select: { handle: true } }),
              prisma.fulfillmentItem.findMany({ where: { shipmentId: s.id }, select: { orderId: true } }),
            ]);
            const orderIds = [...new Set(fitems.map((f) => f.orderId))];
            const orders = orderIds.length
              ? await prisma.order.findMany({ where: { id: { in: orderIds } }, select: { status: true } })
              : [];
            return {
              id: s.id,
              status: s.status,
              buyerHandle: buyer?.handle ?? null,
              sellerHandle: seller?.handle ?? null,
              trackingNumber: s.trackingNumber,
              // Can we release now? Only if a linked order is in the dispute window.
              releasable: orders.some((o) => o.status === 'DISPUTE_WINDOW'),
              items: items.map((it) => ({ id: it.id, title: it.title })),
            };
          }),
        );
        return send(res, 200, out);
      }
      if (req.method === 'POST' && p === '/admin/shipment/mark-shipped') {
        const userId = authUser(req);
        if (!userId) return send(res, 401, { error: 'unauthorized' });
        if (!(await isAdmin(userId, prisma))) return send(res, 403, { error: 'admin required' });
        const b = await readJson(req);
        try {
          // Admin override for the manual case, same path the carrier tracker uses.
          const shipped = await markShipmentShipped(String(b.shipmentId ?? ''), systemClock, prisma);
          await advanceOrdersForShipment(shipped.id, 'SHIPPED', systemClock, prisma);
          return send(res, 200, { ok: true });
        } catch (err) {
          if (err instanceof ShippingError) return send(res, 400, { error: err.message });
          throw err;
        }
      }
      if (req.method === 'POST' && p === '/admin/shipment/mark-delivered') {
        const userId = authUser(req);
        if (!userId) return send(res, 401, { error: 'unauthorized' });
        if (!(await isAdmin(userId, prisma))) return send(res, 403, { error: 'admin required' });
        const b = await readJson(req);
        try {
          await markShipmentDelivered(String(b.shipmentId ?? ''), systemClock, prisma);
          await advanceOrdersForShipment(String(b.shipmentId ?? ''), 'DISPUTE_WINDOW', systemClock, prisma);
          return send(res, 200, { ok: true });
        } catch (err) {
          if (err instanceof ShippingError) return send(res, 400, { error: err.message });
          throw err;
        }
      }
      if (req.method === 'POST' && p === '/admin/shipment/release-now') {
        const userId = authUser(req);
        if (!userId) return send(res, 401, { error: 'unauthorized' });
        if (!(await isAdmin(userId, prisma))) return send(res, 403, { error: 'admin required' });
        const b = await readJson(req);
        const released = await releaseOrdersForShipment(String(b.shipmentId ?? ''), escrow, systemClock, prisma);
        if (released.length === 0) return send(res, 400, { error: 'Nothing to release: no order is in the dispute window.' });
        return send(res, 200, { ok: true, released: released.length });
      }
      /**
       * Send a test email and report exactly what happened. Admin-only.
       * Resend's failure reasons (unverified domain, bad From, sandbox
       * recipient limits) are the actual answer when mail goes missing, and
       * they're invisible from the app otherwise.
       */
      if (req.method === 'POST' && p === '/admin/test-email') {
        const userId = authUser(req);
        if (!userId) return send(res, 401, { error: 'unauthorized' });
        if (!(await isAdmin(userId, prisma))) return send(res, 403, { error: 'admin required' });
        const b = await readJson(req);
        const to = String(b.to ?? '').trim();
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) return send(res, 400, { error: 'Give a valid "to" address.' });
        const result = await sendEmail({
          to,
          subject: 'BIDit test email',
          html: emailShell('Test email', paragraph('If you are reading this, BIDit can deliver mail.')),
        });
        return send(res, result.ok ? 200 : 502, {
          ...result,
          from: emailFrom(),
          configured: emailEnabled(),
        });
      }
      if (req.method === 'GET' && p === '/admin/orders') {
        const userId = authUser(req);
        if (!userId) return send(res, 401, { error: 'unauthorized' });
        if (!(await isAdmin(userId, prisma))) return send(res, 403, { error: 'admin required' });
        return send(res, 200, await ordersDto());
      }
      if (req.method === 'POST' && p === '/admin/order/action') {
        const userId = authUser(req);
        if (!userId) return send(res, 401, { error: 'unauthorized' });
        if (!(await isAdmin(userId, prisma))) return send(res, 403, { error: 'admin required' });
        const b = await readJson(req);
        const orderId = String(b.orderId);
        const action = String(b.action);
        try {
          let status: string;
          if (action === 'ship') status = (await markShipped(orderId, String(b.tracking ?? 'ADMIN'), systemClock, prisma)).status;
          else if (action === 'deliver') status = (await markDelivered(orderId, systemClock, prisma)).status;
          else if (action === 'dispute') status = (await openDispute(orderId, undefined, systemClock, prisma)).status;
          else if (action === 'release') status = (await releaseOrder(orderId, escrow, systemClock, prisma)).status;
          else if (action === 'refund')
            status = (await resolveDispute(orderId, 'REFUND' as DisputeOutcome, escrow, systemClock, prisma)).status;
          else if (action === 'release-disputed')
            status = (await resolveDispute(orderId, 'RELEASE' as DisputeOutcome, escrow, systemClock, prisma)).status;
          else return send(res, 400, { error: 'unknown action' });
          const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
          await realtime.notifyBalance(order.sellerId);
          await realtime.notifyBalance(order.buyerId);
          return send(res, 200, { status });
        } catch (err) {
          return send(res, 400, { error: err instanceof Error ? err.message : 'Action failed' });
        }
      }

      // ---- coin resolution (used by the extension) ----
      if (req.method === 'GET' && p === '/resolve') {
        const resolved = await resolveRoomByCoin(url.searchParams.get('coin') ?? '', prisma);
        if (!resolved) return send(res, 404, { error: 'no seller linked to this coin' });
        return send(res, 200, resolved);
      }
      // Coins a seller has linked: powers the site's "Live right now" section.
      // "live" here = a BIDit auction or giveaway is currently running on it.
      if (req.method === 'GET' && p === '/live') {
        return send(res, 200, await liveCoinsCached((room) => realtime.roomViewerCount(room)));
      }
      // Public storefront for a linked coin: the seller's buy-now items.
      if (req.method === 'GET' && p === '/shop') {
        const mint = url.searchParams.get('coin') ?? '';
        const resolved = await resolveRoomByCoin(mint, prisma);
        if (!resolved) return send(res, 200, { linked: false, sellerHandle: null, items: [] });
        const items = await listStoreItems(resolved.room, prisma);
        return send(res, 200, {
          linked: true,
          sellerHandle: resolved.sellerHandle,
          items: items.map((l) => ({
            id: l.id,
            title: l.title,
            description: l.description,
            price: formatUsdc(l.buyNowPrice!),
            image: l.photos[0] ?? null,
            quantity: l.quantity,
          })),
        });
      }
      // Buy one unit of a store listing outright (charged from available balance).
      if (req.method === 'POST' && p === '/shop/buy') {
        const userId = authUser(req);
        if (!userId) return send(res, 401, { error: 'unauthorized' });
        await requireVerifiedEmail(userId, prisma);
        if (moneyRateLimited(userId)) return send(res, 429, { error: 'Too many requests. Please wait a minute.' });
        const b = await readJson(req);
        try {
          const order = await purchaseListing(userId, String(b.listingId ?? ''), { directPayout, escrow }, prisma);
          await realtime.notifyBalance(userId).catch(() => {});
          await realtime.notifyBalance(order.sellerId).catch(() => {});
          return send(res, 200, { ok: true, orderId: order.id, amount: formatUsdc(order.amount) });
        } catch (err) {
          if (err instanceof ItemUnavailableError) return send(res, 409, { error: err.message });
          if (err instanceof InsufficientFundsError) {
            return send(res, 400, { error: 'Insufficient balance. Add funds to buy this item.' });
          }
          throw err;
        }
      }
      // Server-side proxy for a pump.fun coin's public metadata + live status.
      // (Their API sends no CORS headers, so the browser can't call it directly.)
      if (req.method === 'GET' && p === '/pump/coin') {
        return send(res, 200, await pumpCoinInfo(url.searchParams.get('mint') ?? ''));
      }
      // Live stream token proxy: fetch a pump.fun viewer token so the browser can
      // play the stream directly via LiveKit (no iframe, works past geo-blocks).
      // Gated to coins linked to a BIDit seller.
      if (req.method === 'GET' && p === '/pump/stream') {
        const mint = url.searchParams.get('mint') ?? '';
        const resolved = await resolveRoomByCoin(mint, prisma);
        if (!resolved) return send(res, 200, { live: false, linked: false });
        return send(res, 200, { linked: true, ...(await pumpStreamInfo(mint)) });
      }

      // ---- dev conveniences (legacy dumb page + quick demos) ----
      if (req.method === 'POST' && p === '/dev/deposit') {
        const b = await readJson(req);
        const account = await prisma.account.findUnique({ where: { userId: String(b.userId) } });
        if (!account) return send(res, 404, { error: 'no account' });
        await deposit({ accountId: account.id, amount: usdc(String(b.amount ?? '0')) }, prisma);
        await realtime.notifyBalance(String(b.userId));
        return send(res, 200, { ok: true });
      }
      if (req.method === 'POST' && p === '/dev/demo') {
        const seller = await findOrCreateByHandle(DEMO_SELLER_HANDLE, prisma);
        await prisma.sellerProfile.upsert({
          where: { userId: seller.id },
          update: { verified: true },
          create: { userId: seller.id, verified: true },
        });
        const auctionId = await seedRunningAuction(seller.id, {}, systemClock, prisma);
        await realtime.announceAuction(auctionId);
        return send(res, 200, { room: seller.id, auctionId });
      }
      if (req.method === 'POST' && p === '/dev/link-coin') {
        const b = await readJson(req);
        const coinAddress = String(b.coinAddress ?? '').trim();
        if (!coinAddress) return send(res, 400, { error: 'coinAddress required' });
        const { room, sellerHandle } = await linkCoinToSeller(coinAddress, DEMO_SELLER_HANDLE, prisma);
        const auctionId = await seedRunningAuction(room, {}, systemClock, prisma);
        await realtime.announceAuction(auctionId);
        return send(res, 200, { room, sellerHandle, auctionId });
      }
      if (req.method === 'GET' && p === '/dev/orders') return send(res, 200, await ordersDto());
      if (req.method === 'POST' && p === '/dev/process-timers') {
        return send(res, 200, await processOrderTimers(escrow, systemClock, prisma));
      }

      return send(res, 404, { error: 'not found' });
    } catch (err) {
      const status = (err as { status?: number }).status ?? 500;
      // Our typed domain errors (e.g. PumpCreateError) set BOTH status and a
      // machine-readable code the client branches on (TX_EXPIRED → re-prepare).
      // Only those get the code passed through: untyped errors default to 500
      // above, so Node/Prisma internals (ECONNREFUSED, P2002…) never leak.
      const code = (err as { code?: unknown }).code;
      const typedCode = status !== 500 && typeof code === 'string' ? { code } : {};
      return send(res, status, { error: (err as Error).message, ...typedCode });
    }
  }

  await realtime.listen(PORT);
  realtime.startScheduler();
  console.log(`\nBIDit dev server: http://localhost:${PORT}`);
  console.log('  /        buyer page     /seller  seller dashboard     /admin  admin tools\n');
}

// pump.fun coin metadata + live status, proxied server-side (their API sends no
// CORS headers) and cached briefly so the homepage/watch page can't hammer it.
const pumpCache = new Map<string, { at: number; data: unknown }>();
/** How long pump.fun coin metadata (name, art, is-live) is reused. Their API is
 *  Cloudflare-fronted and rate-limits; at 100 linked coins a 15s TTL meant ~7
 *  requests/second forever. A live badge a minute stale is a fair trade. */
const PUMP_CACHE_MS = 60_000;
// Pump.fun runs streams on LiveKit. `/livestream/join` mints a fresh watch-only
// viewer token per call (unique identity), never cache it, or viewers collide.
const PUMP_LIVEKIT_HOST = process.env.BIDIT_PUMP_LIVEKIT_HOST ?? 'wss://pump-prod-tg2x8veh.livekit.cloud';
// pump.fun's APIs sit behind Cloudflare, which 403s Node's default fetch UA
// ("Just a moment…"). A real browser UA passes the bot check; origin/referer
// make the request look like pump.fun's own site, which matters for the join
// POST when calling from datacenter IPs (Render) that CF scores as bots.
const PUMP_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const PUMP_HEADERS = { 'user-agent': PUMP_UA, origin: 'https://pump.fun', referer: 'https://pump.fun/' };

async function pumpStreamInfo(mint: string) {
  const m = mint.trim();
  if (!/^[A-Za-z0-9]{32,50}$/.test(m)) return { live: false as const };
  try {
    // Title/thumbnail are best-effort. Cache-bust + no-cache: pump's GET /livestream
    // is edge-cached and lags for ~a minute when a stream goes live, so we don't
    // trust its isLive flag.
    const infoRes = await fetch(`https://livestream-api.pump.fun/livestream?mintId=${m}&_=${Date.now()}`, {
      headers: { accept: 'application/json', 'cache-control': 'no-cache', ...PUMP_HEADERS },
      signal: AbortSignal.timeout(6000),
    }).catch(() => null);
    const info = (infoRes && infoRes.ok ? await infoRes.json() : null) as Record<string, unknown> | null;
    const title = (info?.title as string) ?? null;
    const thumbnail = (info?.thumbnail as string) ?? null;
    const streaming = info?.isLive === true; // pump's own (laggy) flag: debug signal only
    // The join POST is uncached; a returned viewer token is the authoritative
    // "live / joinable" signal (it comes back empty when nobody's streaming).
    const joinRes = await fetch('https://livestream-api.pump.fun/livestream/join', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', ...PUMP_HEADERS },
      body: JSON.stringify({ mintId: m }),
      signal: AbortSignal.timeout(6000),
    });
    const join = (joinRes.ok ? await joinRes.json() : null) as { token?: string } | null;
    if (!join?.token) {
      // Loud when it matters: the stream says live but pump won't hand us a
      // viewer token (blocked/changed API): this is the "badge says LIVE but
      // the player says offline" case, so leave a trail in the server logs.
      if (!joinRes.ok || streaming) {
        console.warn(`[pump] livestream/join HTTP ${joinRes.status} for ${m}${streaming ? ': stream reports LIVE but no viewer token' : ''}`);
      }
      return { live: false as const, streaming, title, thumbnail };
    }
    return { live: true as const, streaming, title, thumbnail, host: PUMP_LIVEKIT_HOST, token: join.token };
  } catch (err) {
    console.warn(`[pump] stream lookup failed for ${m}:`, (err as Error).message);
    return { live: false as const };
  }
}

async function pumpCoinInfo(mint: string) {
  const m = mint.trim();
  if (!/^[A-Za-z0-9]{32,50}$/.test(m)) return { unavailable: true, isLive: false };
  const cached = pumpCache.get(m);
  if (cached && Date.now() - cached.at < PUMP_CACHE_MS) return cached.data;
  try {
    const r = await fetch(`https://frontend-api-v3.pump.fun/coins/${m}`, {
      headers: { accept: 'application/json', ...PUMP_HEADERS },
      signal: AbortSignal.timeout(6000),
    });
    if (!r.ok) return { unavailable: true, isLive: false };
    const c = (await r.json()) as Record<string, unknown>;
    const data = {
      name: (c.name as string) ?? null,
      symbol: (c.symbol as string) ?? null,
      image: (c.image_uri as string) ?? null,
      description: (c.description as string) ?? null,
      isLive: c.is_currently_live === true,
    };
    pumpCache.set(m, { at: Date.now(), data });
    return data;
  } catch {
    return { unavailable: true, isLive: false };
  }
}

/**
 * Short-lived cache in front of liveCoins.
 *
 * Every visitor's home page and the Browse poll hit this, so without a cache the
 * work scales with viewers × sellers. Ten seconds is under the auction cadence
 * that matters (bids and closes arrive over the WebSocket, not from here), so
 * the grid stays live while the database sees one build per interval no matter
 * how many people are watching. Concurrent callers share the in-flight promise
 * rather than each starting their own rebuild.
 */
const LIVE_CACHE_MS = 10_000;
let liveCache: { at: number; rows: unknown[] } | null = null;
let liveInFlight: Promise<unknown[]> | null = null;

async function liveCoinsCached(viewerCount: (room: string) => number): Promise<unknown[]> {
  const now = Date.now();
  if (liveCache && now - liveCache.at < LIVE_CACHE_MS) {
    // Viewer counts are free and change fastest, so refresh just those on a hit.
    return (liveCache.rows as { room: string; viewers: number }[]).map((r) => ({
      ...r,
      viewers: viewerCount(r.room),
    }));
  }
  if (!liveInFlight) {
    liveInFlight = liveCoins(viewerCount)
      .then((rows) => {
        liveCache = { at: Date.now(), rows };
        return rows as unknown[];
      })
      .finally(() => {
        liveInFlight = null;
      });
  }
  return liveInFlight;
}

/**
 * Every coin a seller has linked, with whether a BIDit auction/giveaway is live.
 *
 * Written to stay flat as sellers are added. Two things used to make this scale
 * badly, both of which mattered at launch volume:
 *
 *  1. It ran two queries PER SELLER. 100 sellers meant ~200 round trips per
 *     request, multiplied by every viewer loading the page. Now it's three
 *     queries total, regardless of seller count.
 *  2. It inlined cover art and avatars as base64, so a 100-seller response was
 *     tens of megabytes. Those are URLs now (see media.ts) and the browser
 *     caches each image once instead of re-downloading it inside every payload.
 *
 * The result is cached briefly on top of that: see liveCoinsCached.
 */
async function liveCoins(viewerCount: (room: string) => number) {
  const profiles = await prisma.sellerProfile.findMany({
    where: { pumpCoinAddress: { not: null } },
    include: { user: { select: { id: true, handle: true, avatarUrl: true } } },
  });
  if (profiles.length === 0) return [];
  const sellerIds = profiles.map((pf) => pf.userId);

  // One query for every seller's running auction, one for every open giveaway,
  // instead of a pair per seller.
  const [auctions, giveaways] = await Promise.all([
    prisma.auction.findMany({
      where: { status: AuctionStatus.RUNNING, listing: { sellerId: { in: sellerIds } } },
      include: { listing: { select: { sellerId: true, title: true, photos: true } } },
      orderBy: { createdAt: 'desc' },
    }),
    prisma.giveaway.findMany({ where: { sellerId: { in: sellerIds }, status: 'OPEN' } }),
  ]);
  // First wins: both lists are newest-first, matching the old findFirst.
  const auctionBySeller = new Map<string, (typeof auctions)[number]>();
  for (const a of auctions) if (!auctionBySeller.has(a.listing.sellerId)) auctionBySeller.set(a.listing.sellerId, a);
  const giveawayBySeller = new Map<string, (typeof giveaways)[number]>();
  for (const g of giveaways) if (!giveawayBySeller.has(g.sellerId)) giveawayBySeller.set(g.sellerId, g);

  // pump.fun metadata is per-coin and cached inside pumpCoinInfo; this is the
  // only remaining fan-out, and the response cache keeps it off the hot path.
  const pumps = await Promise.all(
    profiles.map((pf) =>
      pumpCoinInfo(pf.pumpCoinAddress!) as Promise<{ name?: string | null; image?: string | null; isLive?: boolean }>,
    ),
  );

  const rows = profiles.map((pf, i) => {
    const auction = auctionBySeller.get(pf.userId) ?? null;
    const giveaway = giveawayBySeller.get(pf.userId) ?? null;
    const pump = pumps[i];
    // Seller-set cover wins, then the running item's photo, then the coin art.
    // Uploads become media URLs; an https value (pump art) passes through.
    const cover =
      mediaUrl('cover', pf.userId, pf.streamImage) ??
      (auction ? mediaUrl('listing', auction.listingId, auction.listing.photos[0]) : null) ??
      pump?.image ??
      null;
    return {
      coin: pf.pumpCoinAddress!,
      sellerHandle: pf.user.handle,
      sellerAvatar: mediaUrl('avatar', pf.userId, pf.user.avatarUrl),
      room: pf.userId,
      hasAuction: auction !== null,
      hasGiveaway: giveaway !== null,
      streamLive: pump?.isLive === true,
      viewers: viewerCount(pf.userId),
      verified: pf.verified,
      coinName: pump?.name ?? null,
      streamTitle: pf.streamTitle ?? null,
      category: pf.streamCategory ?? null,
      country: pf.originCountry ?? null,
      title: auction?.listing.title ?? null,
      image: cover,
      currentBid: auction?.currentBid != null ? formatUsdc(auction.currentBid) : null,
      prize: giveaway?.prize ?? null,
    };
  });
  rows.sort((a, b) => Number(b.hasAuction || b.hasGiveaway) - Number(a.hasAuction || a.hasGiveaway));
  return rows;
}

function giveawayDto(g: {
  id: string;
  kind: string;
  prize: string;
  image: string | null;
  status: string;
  seedHash: string;
  opensAt: Date;
  closesAt: Date;
}) {
  return {
    id: g.id,
    kind: g.kind,
    prize: g.prize,
    image: g.image,
    status: g.status,
    seedHash: g.seedHash,
    opensAt: g.opensAt.getTime(),
    closesAt: g.closesAt.getTime(),
  };
}

function listingDto(l: {
  id: string;
  title: string;
  startingBid: bigint;
  buyNowPrice?: bigint | null;
  status: string;
  quantity: number;
  photos: string[];
  wheel?: unknown;
}) {
  const wheel = normalizeWheelEntries(l.wheel);
  return {
    id: l.id,
    title: l.title,
    startingBid: formatUsdc(l.startingBid),
    buyNowPrice: l.buyNowPrice != null ? formatUsdc(l.buyNowPrice) : null,
    status: l.status,
    quantity: l.quantity,
    imageUrl: l.photos[0] ?? null,
    wheel: wheel.length ? wheel : null,
  };
}

async function buyerFulfillmentDto(buyerId: string) {
  const { items, shipments } = await getBuyerFulfillment(buyerId, prisma);
  return {
    items: items.map((it) => ({
      id: it.id,
      title: it.title,
      image: it.photo,
      weightGrams: it.weightGrams,
      amount: formatUsdc(it.amount),
      sellerId: it.sellerId,
      status: it.status,
      heldUntil: it.heldUntil ? it.heldUntil.getTime() : null,
    })),
    shipments: (await Promise.all(shipments.map((s) => shipmentDto(s.id)))).filter(Boolean),
  };
}

/** The buyer's Purchases overview, every won/bought item across the lifecycle,
 *  bucketed into a `stage` the UI groups by (to_ship / in_transit / delivered). */
async function buyerPurchasesDto(buyerId: string) {
  const rows = await getBuyerPurchases(buyerId, prisma);
  return rows.map((r) => {
    const stage =
      r.status === 'DELIVERED' || r.shipment?.status === 'DELIVERED'
        ? 'delivered'
        : r.status === 'READY_TO_SHIP'
          ? 'to_ship'
          : 'in_transit';
    return {
      id: r.id,
      title: r.title,
      image: r.photo,
      amount: formatUsdc(r.amount),
      stage,
      won: r.won,
      tracking: r.shipment?.trackingNumber ?? null,
      carrier: r.shipment?.carrier ?? null,
      deliveredAt: r.shipment?.deliveredAt ? r.shipment.deliveredAt.getTime() : null,
    };
  });
}

/** Shipment DTO. Deliberately omits `privateLeg2` (the buyer's real address on a
 *  Private shipment), only the operator sees that, never the seller. */
async function shipmentDto(shipmentId: string, opts: { forSeller?: boolean } = {}) {
  const s = await prisma.shipment.findUnique({ where: { id: shipmentId } });
  if (!s) return null;
  const [items, seller, buyer] = await Promise.all([
    shipmentItems(shipmentId, prisma),
    prisma.user.findUnique({ where: { id: s.sellerId }, select: { handle: true } }),
    prisma.user.findUnique({ where: { id: s.buyerId }, select: { handle: true } }),
  ]);
  return {
    id: s.id,
    mode: s.mode,
    status: s.status,
    shippingFee: formatUsdc(s.shippingFee),
    privacyFee: formatUsdc(s.privacyFee),
    trackingNumber: s.trackingNumber,
    carrier: s.carrier,
    // Package size the seller confirmed + the label BIDit generated.
    lengthCm: s.lengthCm,
    widthCm: s.widthCm,
    heightCm: s.heightCm,
    packageWeightG: s.packageWeightG,
    labelUrl: s.labelUrl,
    // BIDit prints the address onto the label; sellers never see/handle it.
    shipTo: opts.forSeller ? null : decryptPii(s.shipTo),
    sellerHandle: seller?.handle ?? null,
    buyerHandle: buyer?.handle ?? null,
    createdAt: s.createdAt.getTime(),
    paidAt: s.paidAt ? s.paidAt.getTime() : null,
    confirmedAt: s.confirmedAt ? s.confirmedAt.getTime() : null,
    labelCreatedAt: s.labelCreatedAt ? s.labelCreatedAt.getTime() : null,
    shippedAt: s.shippedAt ? s.shippedAt.getTime() : null,
    items: items.map((it) => ({ id: it.id, title: it.title, image: it.photo, amount: formatUsdc(it.amount) })),
  };
}

async function sellerOrdersDto(sellerId: string) {
  const orders = await prisma.order.findMany({
    where: { sellerId },
    orderBy: { createdAt: 'desc' },
    take: 50,
    include: {
      buyer: { select: { handle: true } },
      auction: { select: { listing: { select: { title: true, photos: true } } } },
      listing: { select: { title: true, photos: true } }, // store orders link the listing directly
    },
  });
  return orders.map((o) => {
    const listing = o.auction?.listing ?? o.listing;
    return {
      id: o.id,
      status: o.status,
      kind: o.auctionId ? 'auction' : 'store',
      amount: formatUsdc(o.amount),
      sellerProceeds: formatUsdc(o.sellerProceeds),
      platformFee: formatUsdc(o.platformFee),
      buyer: o.buyer.handle,
      title: listing?.title ?? 'Item',
      image: listing?.photos[0] ?? null,
      trackingNumber: o.trackingNumber,
      createdAt: o.createdAt.getTime(),
    };
  });
}

async function ordersDto() {
  const orders = await prisma.order.findMany({
    orderBy: { createdAt: 'desc' },
    take: 60,
    include: {
      buyer: { select: { handle: true } },
      seller: { select: { handle: true } },
      auction: { select: { listing: { select: { title: true } } } },
      listing: { select: { title: true } }, // store orders link the listing directly
    },
  });
  return orders.map((o) => ({
    id: o.id,
    status: o.status,
    title: o.auction?.listing.title ?? o.listing?.title ?? 'Item',
    amount: formatUsdc(o.amount),
    platformFee: formatUsdc(o.platformFee),
    sellerProceeds: formatUsdc(o.sellerProceeds),
    buyer: o.buyer.handle,
    seller: o.seller.handle,
    trackingNumber: o.trackingNumber,
    createdAt: o.createdAt.getTime(),
    disputeWindowEndsAt: o.disputeWindowEndsAt ? o.disputeWindowEndsAt.getTime() : null,
    noShipDeadline: o.noShipDeadline ? o.noShipDeadline.getTime() : null,
  }));
}

async function ensureAdmin() {
  const existing = await prisma.user.findUnique({ where: { handle: 'admin' } });
  const admin = existing ?? (await prisma.user.create({ data: { handle: 'admin', role: Role.admin } }));
  if (admin.role !== Role.admin) await prisma.user.update({ where: { id: admin.id }, data: { role: Role.admin } });
  await getOrCreateUserAccount(admin.id, prisma);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
