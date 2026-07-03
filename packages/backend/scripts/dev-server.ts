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
import { getOrCreateUserAccount, deposit, getAvailableBalance, getSettledBalance } from '../src/ledger.js';
import { RealtimeServer } from '../src/realtime/server.js';
import {
  issueSession,
  verifySession,
  parseBearer,
  buildLoginChallenge,
  verifyWalletSignature,
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
  AuthError,
} from '../src/authz.js';
import {
  resolveRoomByCoin,
  linkCoinToSeller,
  seedRunningAuction,
  setSellerCoin,
  startAuctionFromListing,
} from '../src/sellers.js';
import { createListing, listSellerListings, setListingWheel } from '../src/listings.js';
import { openGiveaway, getOpenGiveaway } from '../src/giveaways.js';
import { verifySeller, listSellers, ledgerAudit } from '../src/admin.js';
import { DevWalletEscrow } from '../src/escrow.js';
import { getChainClient, MockChain } from '../src/chain/index.js';
import { ensureDepositAddress, DepositWatcher, registerAllDeposits } from '../src/deposits.js';
import { requestWithdrawal } from '../src/withdrawals.js';
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
  shipmentItems,
  createAndPayShipment,
  markShipmentShipped,
  markShipmentDelivered,
  discardItem,
  ShippingError,
  type ShipMode,
} from '../src/fulfillment.js';
import { systemClock } from '../src/clock.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 8787);

// Last-resort safety net: log stray async errors instead of letting Node crash
// the whole server (Node exits on an unhandled rejection by default). A payments
// backend must stay up; individual operations already handle their own failures.
process.on('unhandledRejection', (reason) => console.error('[unhandledRejection]', reason));
process.on('uncaughtException', (err) => console.error('[uncaughtException]', err));
const DEMO_SELLER_HANDLE = 'demo_seller';

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, PATCH, PUT, DELETE, OPTIONS',
  'access-control-allow-headers': 'content-type, authorization',
};

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
  res.writeHead(status, { 'content-type': type, ...CORS });
  res.end(payload);
}

async function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>;
  } catch {
    return {};
  }
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

  // Direct-payout mode (BIDIT_PAYOUT_MODE=direct): on a sale, pay the seller 100%
  // immediately — no escrow, no 5% fee. Used for the real-money friends test.
  const directPayout = process.env.BIDIT_PAYOUT_MODE === 'direct';
  const escrow = new DevWalletEscrow(prisma);
  const chain = await getChainClient(); // MockChain unless SOLANA_RPC is set
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
  depositWatcher.start();

  // Dev endpoints (password-less login, balance minting, seeders) are ON only for
  // the local mock chain, OFF on any real chain unless explicitly forced.
  const devEndpoints = chain.cluster === 'mock' || process.env.BIDIT_ENABLE_DEV_ENDPOINTS === 'yes';

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
      shippingAddress: user.shippingAddress,
      interests: user.interests,
      onboarded: user.onboarded,
      role: user.role,
      walletAddress: user.walletAddress,
      verified: profile?.verified === true,
      pumpCoinAddress: profile?.pumpCoinAddress ?? null,
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
    if (req.method === 'OPTIONS') {
      res.writeHead(204, CORS);
      res.end();
      return;
    }
    const p = url.pathname;
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
        const b = await readJson(req);
        const wallet = String(b.walletAddress ?? '').trim();
        if (!wallet) return send(res, 400, { error: 'walletAddress required' });
        return send(res, 200, { message: buildLoginChallenge(wallet) });
      }
      if (req.method === 'POST' && p === '/auth/verify') {
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

      // ---- authenticated: me / deposit ----
      if (req.method === 'GET' && p === '/me') {
        const userId = authUser(req);
        if (!userId) return send(res, 401, { error: 'unauthorized' });
        return send(res, 200, await sessionPayload(userId));
      }
      if (req.method === 'POST' && p === '/deposit') {
        const userId = authUser(req);
        if (!userId) return send(res, 401, { error: 'unauthorized' });
        const b = await readJson(req);
        const accountId = await getOrCreateUserAccount(userId, prisma);
        await deposit({ accountId, amount: usdc(String(b.amount ?? '0')) }, prisma);
        await realtime.notifyBalance(userId);
        return send(res, 200, { available: formatUsdc(await getAvailableBalance(accountId, prisma)) });
      }
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

      // ---- fulfillment (buyer) ----
      if (req.method === 'GET' && p === '/me/fulfillment') {
        const userId = authUser(req);
        if (!userId) return send(res, 401, { error: 'unauthorized' });
        return send(res, 200, await buyerFulfillmentDto(userId));
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
      if (req.method === 'GET' && p === '/seller/orders') {
        const userId = authUser(req);
        if (!userId) return send(res, 401, { error: 'unauthorized' });
        return send(res, 200, await sellerOrdersDto(userId));
      }
      if (req.method === 'POST' && p === '/seller/coin') {
        const userId = authUser(req);
        if (!userId) return send(res, 401, { error: 'unauthorized' });
        const b = await readJson(req);
        await setSellerCoin(userId, String(b.coinAddress ?? '').trim(), prisma);
        return send(res, 200, { ok: true });
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
            quantity: b.quantity ? Number(b.quantity) : undefined,
            weightGrams: b.weightGrams ? Number(b.weightGrams) : undefined,
            category: b.category ? String(b.category) : undefined,
          },
          prisma,
        );
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
      if (req.method === 'GET' && p === '/admin/orders') {
        const userId = authUser(req);
        if (!userId) return send(res, 401, { error: 'unauthorized' });
        const user = await getUser(userId, prisma);
        if (user?.role !== Role.admin) return send(res, 403, { error: 'admin required' });
        return send(res, 200, await ordersDto());
      }
      if (req.method === 'POST' && p === '/admin/order/action') {
        const userId = authUser(req);
        if (!userId) return send(res, 401, { error: 'unauthorized' });
        const user = await getUser(userId, prisma);
        if (user?.role !== Role.admin) return send(res, 403, { error: 'admin required' });
        const b = await readJson(req);
        const orderId = String(b.orderId);
        const action = String(b.action);
        let status: string;
        if (action === 'dispute') status = (await openDispute(orderId, systemClock, prisma)).status;
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
      // Server-side proxy for a pump.fun coin's public metadata + live status.
      // (Their API sends no CORS headers, so the browser can't call it directly.)
      if (req.method === 'GET' && p === '/pump/coin') {
        return send(res, 200, await pumpCoinInfo(url.searchParams.get('mint') ?? ''));
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
async function pumpCoinInfo(mint: string) {
  const m = mint.trim();
  if (!/^[A-Za-z0-9]{32,50}$/.test(m)) return { unavailable: true, isLive: false };
  const cached = pumpCache.get(m);
  if (cached && Date.now() - cached.at < 15_000) return cached.data;
  try {
    const r = await fetch(`https://frontend-api-v3.pump.fun/coins/${m}`, {
      headers: { accept: 'application/json' },
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
    shipTo: s.shipTo,
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
    },
  });
  return orders.map((o) => ({
    id: o.id,
    status: o.status,
    amount: formatUsdc(o.amount),
    sellerProceeds: formatUsdc(o.sellerProceeds),
    platformFee: formatUsdc(o.platformFee),
    buyer: o.buyer.handle,
    title: o.auction.listing.title,
    image: o.auction.listing.photos[0] ?? null,
    trackingNumber: o.trackingNumber,
    createdAt: o.createdAt.getTime(),
  }));
}

async function ordersDto() {
  const orders = await prisma.order.findMany({
    orderBy: { createdAt: 'desc' },
    take: 25,
    include: { buyer: { select: { handle: true } }, seller: { select: { handle: true } } },
  });
  return orders.map((o) => ({
    id: o.id,
    status: o.status,
    amount: formatUsdc(o.amount),
    platformFee: formatUsdc(o.platformFee),
    sellerProceeds: formatUsdc(o.sellerProceeds),
    buyer: o.buyer.handle,
    seller: o.seller.handle,
    trackingNumber: o.trackingNumber,
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
