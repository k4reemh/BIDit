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
  AuthError,
  revokeUserSessions,
  loadSessionRevocations,
  eraseUserData,
} from '../src/authz.js';
import { sellerFulfilledCount, VERIFY_THRESHOLD } from '../src/seller-verify.js';
import { promoState, sellerPromoStatus, listPromoSellers, markPromoPaid } from '../src/promo.js';
import {
  resolveRoomByCoin,
  linkCoinToSeller,
  seedRunningAuction,
  setSellerCoin,
  startAuctionFromListing,
} from '../src/sellers.js';
import { createListing, listSellerListings, setListingWheel, setListingStorePrice } from '../src/listings.js';
import { purchaseListing, listStoreItems, ItemUnavailableError } from '../src/store.js';
import { openGiveaway, getOpenGiveaway } from '../src/giveaways.js';
import { getPointsSummary, claimMission, getLeaderboard, PointsError } from '../src/points.js';
import { verifySeller, listSellers, ledgerAudit } from '../src/admin.js';
import { DevWalletEscrow } from '../src/escrow.js';
import { getChainClient, MockChain } from '../src/chain/index.js';
import { ensureDepositAddress, DepositWatcher, registerAllDeposits } from '../src/deposits.js';
import { requestWithdrawal, WithdrawalError } from '../src/withdrawals.js';
import {
  markShipped,
  markDelivered,
  openDispute,
  resolveDispute,
  releaseOrder,
  processOrderTimers,
  type DisputeOutcome,
} from '../src/orders.js';
import {
  getBuyerFulfillment,
  getSellerShipments,
  getSellerHeldItems,
  listPrivateShipments,
  shipmentItems,
  createAndPayShipment,
  estimateShipment,
  estimateListingShipping,
  markShipmentShipped,
  markShipmentDelivered,
  discardItem,
  processFulfillmentTimers,
  ShippingError,
  type ShipMode,
} from '../src/fulfillment.js';
import { listNotifications, markAllRead } from '../src/notifications.js';
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

// Throttle auth endpoints per-IP to blunt credential-stuffing / brute force.
const authHits = new Map<string, number[]>();
function authRateLimited(req: http.IncomingMessage): boolean {
  const ip = req.socket.remoteAddress ?? 'unknown';
  const now = Date.now();
  const recent = (authHits.get(ip) ?? []).filter((t) => now - t < 60_000);
  recent.push(now);
  authHits.set(ip, recent);
  return recent.length > 10; // >10 attempts / minute / IP
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

// 4 MB — comfortably fits the app's largest legitimate body (a listing with a few
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
  // immediately — no escrow, no 5% fee. Used for the real-money friends test.
  const directPayout = process.env.BIDIT_PAYOUT_MODE === 'direct';
  const escrow = new DevWalletEscrow(prisma);
  const chain = await getChainClient(); // MockChain unless SOLANA_RPC is set
  // Fail fast on an unsafe production/real-money configuration (missing/weak
  // AUTH_SECRET, a mock chain in prod, force-enabled dev endpoints, missing
  // custody secrets). Throws → main().catch → process.exit(1).
  const { isProd } = assertStartupConfig(chain.cluster);
  if (usingDefaultAuthSecret() && chain.cluster !== 'mock') {
    console.warn('[config] ⚠️  AUTH_SECRET is the insecure default on a real chain — set a strong value before exposing this deploy.');
  }
  if (isProd && corsAllowlist().length === 0) {
    console.warn('[config] ⚠️  BIDIT_ALLOWED_ORIGINS is empty in production — CORS is failing open (any origin). Set it to your web origin to lock this down.');
  }
  if (isProd && !piiEncryptionEnabled()) {
    console.warn('[config] ⚠️  BIDIT_PII_KEY is not set — shipping addresses are stored unencrypted. Set a strong key to encrypt PII at rest.');
  }
  // Register existing users so their deposits are watched across restarts.
  await registerAllDeposits(chain, prisma).catch((e) => console.error('[deposits] register', e));
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
  // on-screen without a refresh.
  const depositWatcher = new DepositWatcher(chain, prisma, 5000, (userId) =>
    void realtime.notifyBalance(userId).catch(() => {}),
  );
  // Recover any deposit that was swept on-chain but not yet credited before a
  // prior crash/restart, then start the live poller.
  await depositWatcher.reconcile().then(
    (n) => n > 0 && console.log(`[deposits] reconciled ${n} pending deposit(s) on startup`),
    (e) => console.error('[deposits] startup reconcile failed:', e),
  );
  depositWatcher.start();
  // Auto-discard Ready-to-Ship items past their 7-day seller hold (ship-later).
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
  // the local mock chain, OFF on any real chain unless explicitly forced — and
  // ALWAYS off in production (assertStartupConfig already rejected the force flag,
  // but this is defence-in-depth on the money-endpoint gate).
  const devEndpoints = !isProd && (chain.cluster === 'mock' || process.env.BIDIT_ENABLE_DEV_ENDPOINTS === 'yes');

  console.log(`[chain] cluster=${chain.cluster} · payout=${directPayout ? 'DIRECT (no escrow, no fee)' : 'escrow (95/5)'} · dev-endpoints=${devEndpoints ? 'on' : 'off'}`);
  if (chain.cluster === 'mainnet-beta') {
    console.log('[chain] ⚠️  MAINNET — REAL USDC WILL MOVE. treasury:', chain.walletAddress('treasury'));
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
      website: profile?.website ?? null,
      socials: (profile?.socials as Record<string, string> | null) ?? null,
      pitch: profile?.pitch ?? null,
      shipping: {
        originCountry: profile?.originCountry ?? null,
        originRegion: profile?.originRegion ?? null,
        originCity: profile?.originCity ?? null,
        originPostal: profile?.originPostal ?? null,
        weeklyBundling: profile?.weeklyBundling ?? false,
        shipLater: profile?.shipLater ?? false,
        privateShipping: profile?.privateShipping ?? false,
      },
      depositAddress: await ensureDepositAddress(userId, chain, prisma),
      cluster: chain.cluster, // 'mock' | 'devnet' | 'mainnet-beta' — drives the deposit UI
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
    // Operational transparency: which chain/payout/dev mode is this process in.
    // Unauthenticated + cheap; exposes only mode flags, never secrets or balances.
    if (req.method === 'GET' && p === '/health') {
      return send(res, 200, {
        ok: true,
        chain: chain.cluster,
        mainnet: chain.cluster === 'mainnet-beta',
        payout: directPayout ? 'direct' : 'escrow',
        devEndpoints,
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
          return send(res, 200, await sessionPayload(user.id));
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
      if (req.method === 'POST' && p === '/withdraw') {
        const userId = authUser(req);
        if (!userId) return send(res, 401, { error: 'unauthorized' });
        const b = await readJson(req);
        const toAddress = String(b.toAddress ?? '').trim();
        const amount = usdc(String(b.amount ?? '0'));
        if (!toAddress) return send(res, 400, { error: 'Enter a destination address.' });
        if (amount <= 0n) return send(res, 400, { error: 'Enter an amount greater than 0.' });
        try {
          const w = await requestWithdrawal(userId, toAddress, amount, chain, prisma);
          await realtime.notifyBalance(userId);
          const accountId = await getOrCreateUserAccount(userId, prisma);
          return send(res, 200, {
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
      if (req.method === 'POST' && p === '/shipping/quote-listing') {
        const userId = authUser(req);
        if (!userId) return send(res, 401, { error: 'unauthorized' });
        const b = await readJson(req);
        try {
          const est = await estimateListingShipping(userId, String(b.listingId ?? ''), prisma);
          return send(res, 200, {
            shippingFee: formatUsdc(est.shippingFee),
            carrierRetail: formatUsdc(est.carrierRetail),
            discountPct: est.discountPct,
            privacyFee: formatUsdc(est.privacyFee),
            hasAddress: est.hasAddress,
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
        try {
          const est = await estimateShipment({ buyerId: userId, itemIds, private: b.private === true }, prisma);
          return send(res, 200, {
            shippingFee: formatUsdc(est.shippingFee),
            carrierRetail: formatUsdc(est.carrierRetail),
            discountPct: est.discountPct,
            privacyFee: formatUsdc(est.privacyFee),
            total: formatUsdc(est.total),
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
        try {
          const shipment = await createAndPayShipment(
            { buyerId: userId, itemIds, mode: b.mode as ShipMode | undefined, private: b.private === true },
            systemClock,
            prisma,
          );
          await realtime.notifyBalance(userId);
          return send(res, 200, await shipmentDto(shipment.id));
        } catch (err) {
          if (err instanceof ShippingError) return send(res, 400, { error: err.message });
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
          await discardItem(String(b.itemId ?? ''), userId, systemClock, prisma);
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
          return send(res, 200, await buyerFulfillmentDto(userId));
        } catch (err) {
          if (err instanceof ShippingError) return send(res, 400, { error: err.message });
          throw err;
        }
      }

      // ---- seller ----
      if (req.method === 'POST' && p === '/seller/apply') {
        const userId = authUser(req);
        if (!userId) return send(res, 401, { error: 'unauthorized' });
        await applyAsSeller(userId, prisma);
        return send(res, 200, await sessionPayload(userId));
      }
      if (req.method === 'POST' && p === '/seller/onboarding') {
        const userId = authUser(req);
        if (!userId) return send(res, 401, { error: 'unauthorized' });
        const b = await readJson(req);
        await submitSellerOnboarding(
          userId,
          {
            website: typeof b.website === 'string' ? b.website : undefined,
            socials: b.socials && typeof b.socials === 'object' ? (b.socials as Record<string, string>) : undefined,
            pitch: typeof b.pitch === 'string' ? b.pitch : undefined,
            coinAddress: typeof b.coinAddress === 'string' ? b.coinAddress : undefined,
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
        const b = await readJson(req);
        await setSellerCoin(userId, String(b.coinAddress ?? '').trim(), prisma);
        return send(res, 200, { ok: true });
      }
      // Livestream identity: a custom stream title (shown on the live cards instead
      // of the coin name) and the category tag for the stream.
      if (req.method === 'POST' && p === '/seller/stream-settings') {
        const userId = authUser(req);
        if (!userId) return send(res, 401, { error: 'unauthorized' });
        const b = await readJson(req);
        const clip = (v: unknown, max: number) =>
          typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null;
        const data = {
          streamTitle: clip(b.streamTitle, 80),
          streamCategory: clip(b.streamCategory, 40),
        };
        await prisma.sellerProfile.upsert({
          where: { userId },
          update: data,
          create: { userId, ...data },
        });
        return send(res, 200, await sessionPayload(userId));
      }
      if (req.method === 'POST' && p === '/seller/shipping-settings') {
        const userId = authUser(req);
        if (!userId) return send(res, 401, { error: 'unauthorized' });
        const b = await readJson(req);
        const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
        const data = {
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
        return send(res, 200, await Promise.all(shipments.map((s) => shipmentDto(s.id))));
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
      if (req.method === 'POST' && p === '/seller/shipment/ship') {
        const userId = authUser(req);
        if (!userId) return send(res, 401, { error: 'unauthorized' });
        const b = await readJson(req);
        try {
          await markShipmentShipped(
            {
              shipmentId: String(b.shipmentId ?? ''),
              sellerId: userId,
              trackingNumber: b.trackingNumber ? String(b.trackingNumber) : undefined,
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
      if (req.method === 'POST' && p === '/seller/order/ship') {
        const userId = authUser(req);
        if (!userId) return send(res, 401, { error: 'unauthorized' });
        const b = await readJson(req);
        const order = await prisma.order.findUnique({ where: { id: String(b.orderId) } });
        if (!order || order.sellerId !== userId) return send(res, 403, { error: 'not your order' });
        const updated = await markShipped(order.id, String(b.tracking ?? 'TRACKING'), systemClock, prisma);
        return send(res, 200, { status: updated.status });
      }
      if (req.method === 'POST' && p === '/seller/order/deliver') {
        const userId = authUser(req);
        if (!userId) return send(res, 401, { error: 'unauthorized' });
        const b = await readJson(req);
        const order = await prisma.order.findUnique({ where: { id: String(b.orderId) } });
        if (!order || order.sellerId !== userId) return send(res, 403, { error: 'not your order' });
        const updated = await markDelivered(order.id, systemClock, prisma);
        return send(res, 200, { status: updated.status });
      }

      // ---- admin ----
      if (req.method === 'GET' && p === '/admin/sellers') {
        const userId = authUser(req);
        if (!userId) return send(res, 401, { error: 'unauthorized' });
        return send(res, 200, await listSellers(userId, prisma));
      }
      // Admin: enrolled sellers + $ fulfilled, so you know who to pay the $100.
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
      if (req.method === 'GET' && p === '/admin/audit') {
        const userId = authUser(req);
        if (!userId) return send(res, 401, { error: 'unauthorized' });
        return send(res, 200, await ledgerAudit(userId, prisma));
      }
      // Operator-only: Private Secure Shipping reship queue. Exposes each buyer's
      // REAL address (privateLeg2) — never shown to sellers — so the operator can
      // ship the hub→buyer leg.
      if (req.method === 'GET' && p === '/admin/private-shipments') {
        const userId = authUser(req);
        if (!userId) return send(res, 401, { error: 'unauthorized' });
        const user = await getUser(userId, prisma);
        if (user?.role !== Role.admin) return send(res, 403, { error: 'admin required' });
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
          else if (action === 'dispute') status = (await openDispute(orderId, systemClock, prisma)).status;
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
      // Coins a seller has linked — powers the site's "Live right now" section.
      // "live" here = a BIDit auction or giveaway is currently running on it.
      if (req.method === 'GET' && p === '/live') {
        return send(res, 200, await liveCoins());
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
        const b = await readJson(req);
        try {
          const order = await purchaseListing(userId, String(b.listingId ?? ''), { directPayout, escrow }, prisma);
          await realtime.notifyBalance(userId).catch(() => {});
          await realtime.notifyBalance(order.sellerId).catch(() => {});
          return send(res, 200, { ok: true, orderId: order.id, amount: formatUsdc(order.amount) });
        } catch (err) {
          if (err instanceof ItemUnavailableError) return send(res, 409, { error: err.message });
          if (err instanceof InsufficientFundsError) {
            return send(res, 400, { error: 'Insufficient balance — add funds to buy this item' });
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
      return send(res, status, { error: (err as Error).message });
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
// Pump.fun runs streams on LiveKit. `/livestream/join` mints a fresh watch-only
// viewer token per call (unique identity) — never cache it, or viewers collide.
const PUMP_LIVEKIT_HOST = process.env.BIDIT_PUMP_LIVEKIT_HOST ?? 'wss://pump-prod-tg2x8veh.livekit.cloud';
// pump.fun's APIs sit behind Cloudflare, which 403s Node's default fetch UA
// ("Just a moment…"). A real browser UA passes the bot check.
const PUMP_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

async function pumpStreamInfo(mint: string) {
  const m = mint.trim();
  if (!/^[A-Za-z0-9]{32,50}$/.test(m)) return { live: false as const };
  try {
    // Title/thumbnail are best-effort. Cache-bust + no-cache: pump's GET /livestream
    // is edge-cached and lags for ~a minute when a stream goes live, so we don't
    // trust its isLive flag.
    const infoRes = await fetch(`https://livestream-api.pump.fun/livestream?mintId=${m}&_=${Date.now()}`, {
      headers: { accept: 'application/json', 'cache-control': 'no-cache', 'user-agent': PUMP_UA },
      signal: AbortSignal.timeout(6000),
    }).catch(() => null);
    const info = (infoRes && infoRes.ok ? await infoRes.json() : null) as Record<string, unknown> | null;
    const title = (info?.title as string) ?? null;
    const thumbnail = (info?.thumbnail as string) ?? null;
    // The join POST is uncached; a returned viewer token is the authoritative
    // "live / joinable" signal (it comes back empty when nobody's streaming).
    const joinRes = await fetch('https://livestream-api.pump.fun/livestream/join', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', 'user-agent': PUMP_UA },
      body: JSON.stringify({ mintId: m }),
      signal: AbortSignal.timeout(6000),
    });
    const join = (joinRes.ok ? await joinRes.json() : null) as { token?: string } | null;
    if (!join?.token) return { live: false as const, title, thumbnail };
    return { live: true as const, title, thumbnail, host: PUMP_LIVEKIT_HOST, token: join.token };
  } catch {
    return { live: false as const };
  }
}

async function pumpCoinInfo(mint: string) {
  const m = mint.trim();
  if (!/^[A-Za-z0-9]{32,50}$/.test(m)) return { unavailable: true, isLive: false };
  const cached = pumpCache.get(m);
  if (cached && Date.now() - cached.at < 15_000) return cached.data;
  try {
    const r = await fetch(`https://frontend-api-v3.pump.fun/coins/${m}`, {
      headers: { accept: 'application/json', 'user-agent': PUMP_UA },
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

// Every coin a seller has linked, with whether a BIDit auction/giveaway is live on it.
async function liveCoins() {
  const profiles = await prisma.sellerProfile.findMany({
    where: { pumpCoinAddress: { not: null } },
    include: { user: { select: { id: true, handle: true } } },
  });
  const rows = await Promise.all(
    profiles.map(async (pf) => {
      const [auction, giveaway, pump] = await Promise.all([
        prisma.auction.findFirst({
          where: { status: AuctionStatus.RUNNING, listing: { sellerId: pf.userId } },
          include: { listing: { select: { title: true, photos: true } } },
          orderBy: { createdAt: 'desc' },
        }),
        prisma.giveaway.findFirst({ where: { sellerId: pf.userId, status: 'OPEN' } }),
        pumpCoinInfo(pf.pumpCoinAddress!) as Promise<{ name?: string | null; image?: string | null; isLive?: boolean }>,
      ]);
      return {
        coin: pf.pumpCoinAddress!,
        sellerHandle: pf.user.handle,
        room: pf.userId,
        hasAuction: auction !== null,
        hasGiveaway: giveaway !== null,
        streamLive: pump?.isLive === true,
        coinName: pump?.name ?? null,
        streamTitle: pf.streamTitle ?? null,
        category: pf.streamCategory ?? null,
        country: pf.originCountry ?? null,
        title: auction?.listing.title ?? null,
        image: auction?.listing.photos[0] ?? pump?.image ?? null,
        currentBid: auction?.currentBid != null ? formatUsdc(auction.currentBid) : null,
        prize: giveaway?.prize ?? null,
      };
    }),
  );
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

/** Shipment DTO. Deliberately omits `privateLeg2` (the buyer's real address on a
 *  Private shipment) — only the operator sees that, never the seller. */
async function shipmentDto(shipmentId: string) {
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
    shipTo: decryptPii(s.shipTo),
    sellerHandle: seller?.handle ?? null,
    buyerHandle: buyer?.handle ?? null,
    createdAt: s.createdAt.getTime(),
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
