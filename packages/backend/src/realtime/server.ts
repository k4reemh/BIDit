/**
 * The realtime WebSocket server (Chunk 3).
 *
 * Thin transport over the Chunk 2 engine: a BID_INTENT runs the exact `placeBid`
 * pipeline — the socket layer never re-implements validation or touches money.
 * Every state-changing broadcast carries `serverNow` so clients re-sync their
 * countdown and never drift.
 *
 * Fan-out goes through a RealtimeBus (in-memory here; Redis in production),
 * keyed by `room:{sellerId}` and `user:{userId}` channels, so this works
 * unchanged across multiple backend instances.
 */
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, WebSocket, type RawData } from 'ws';
import {
  AuctionStatus,
  RealtimeRejectReason,
  roomChannel,
  userChannel,
  parseClientMessage,
  minNextBid,
  formatUsdc,
  usdc,
  type IncrementConfig,
  type ServerMessage,
  type AuctionStateMessage,
  type BidAcceptedMessage,
  type AuctionClosedMessage,
  type BalanceUpdateMessage,
  type BidIntentMessage,
  type RandomizerSpinMessage,
  type WheelEntry,
  pickSlot,
  buildReel,
  normalizeWheelEntries,
  buildRollOrder,
  normalizeGiveawayKind,
  type GiveawayEnterMessage,
  type GiveawayOpenMessage,
  type GiveawayEntriesMessage,
  type GiveawayWinnerMessage,
} from '@bidit/shared';
import { createHash, randomBytes } from 'node:crypto';
import { prisma as defaultPrisma } from '../db.js';
import type { PrismaClient } from '../db.js';
import { placeBid } from '../auction.js';
import type { CloseResult } from '../auction.js';
import { getSettledBalance, getAvailableBalance } from '../ledger.js';
import { AuctionScheduler } from '../scheduler.js';
import { systemClock, type Clock } from '../clock.js';
import { InMemoryBus, type BusHandler, type RealtimeBus, type Unsubscribe } from './bus.js';
import { verifySession } from '../auth.js';
import { settleAuction, settleAuctionDirect } from '../orders.js';
import type { EscrowProvider } from '../escrow.js';
import { enterGiveaway, drawGiveaway, listEntrants, type DrawResult } from '../giveaways.js';

interface Conn {
  id: string;
  ws: WebSocket;
  userId: string;
  rooms: Set<string>;
}

export interface RealtimeServerOptions {
  prisma?: PrismaClient;
  bus?: RealtimeBus;
  clock?: Clock;
  /** Reuse an existing http server (the dev server shares one for REST + static). */
  httpServer?: http.Server;
  rateLimitPerSec?: number;
  schedulerIntervalMs?: number;
  /** When set, a closed auction with a winner is settled into a LOCKED order. */
  escrow?: EscrowProvider;
  /** Direct-payout mode: on a sale, pay the seller 100% immediately (no escrow,
   *  no fee). Takes precedence over `escrow`. For the live/no-escrow test. */
  directPayout?: boolean;
}

/** How long after a close we'll replay its result to a (re)subscribing client. */
const CLOSE_REPLAY_WINDOW_MS = 60_000;

export class RealtimeServer {
  readonly httpServer: http.Server;
  readonly scheduler: AuctionScheduler;
  private readonly wss: WebSocketServer;
  private readonly prisma: PrismaClient;
  private readonly bus: RealtimeBus;
  private readonly clock: Clock;
  private readonly ownsHttpServer: boolean;
  private readonly rateLimitPerSec: number;
  private readonly escrow?: EscrowProvider;
  private readonly directPayout: boolean;

  private readonly conns = new Map<string, Conn>();
  private readonly localRooms = new Map<string, Set<string>>();
  private readonly localUsers = new Map<string, Set<string>>();
  private readonly busSubs = new Map<string, { unsub: Unsubscribe; refCount: number }>();
  private readonly rate = new Map<string, number[]>();
  private readonly giveawayTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(opts: RealtimeServerOptions = {}) {
    this.prisma = opts.prisma ?? defaultPrisma;
    this.bus = opts.bus ?? new InMemoryBus();
    this.clock = opts.clock ?? systemClock;
    this.rateLimitPerSec = opts.rateLimitPerSec ?? 5;
    this.escrow = opts.escrow;
    this.directPayout = opts.directPayout ?? false;
    this.ownsHttpServer = !opts.httpServer;
    this.httpServer = opts.httpServer ?? http.createServer();
    this.wss = new WebSocketServer({ server: this.httpServer, path: '/ws' });
    this.wss.on('connection', (ws, req) => void this.onConnection(ws, req));
    this.scheduler = new AuctionScheduler({
      clock: this.clock,
      prisma: this.prisma,
      intervalMs: opts.schedulerIntervalMs ?? 250,
      onClose: (results) => void this.onAuctionsClosed(results),
    });
  }

  async listen(port = 0): Promise<number> {
    // Bind whether we own the http server or it was passed in (the dev server
    // delegates listening to us). Idempotent if it is already listening.
    if (!this.httpServer.listening) {
      await new Promise<void>((resolve) => this.httpServer.listen(port, resolve));
    }
    return (this.httpServer.address() as AddressInfo).port;
  }

  startScheduler(): void {
    this.scheduler.start();
  }

  /** For tests: run one scheduler poll deterministically (no interval). */
  async tickScheduler(): Promise<CloseResult[]> {
    return this.scheduler.tick();
  }

  async close(): Promise<void> {
    this.scheduler.stop();
    for (const t of this.giveawayTimers.values()) clearTimeout(t);
    this.giveawayTimers.clear();
    for (const conn of this.conns.values()) conn.ws.terminate();
    this.conns.clear();
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
    if (this.ownsHttpServer) {
      await new Promise<void>((resolve) => this.httpServer.close(() => resolve()));
    }
    for (const { unsub } of this.busSubs.values()) await unsub().catch(() => {});
    this.busSubs.clear();
  }

  // ---- public hooks for the dev server -----------------------------------

  /** Push a fresh BALANCE_UPDATE to a user (e.g. after a deposit). */
  async notifyBalance(userId: string): Promise<void> {
    await this.sendBalanceUpdate(userId);
  }

  /** Broadcast a fresh AUCTION_STATE to the room (e.g. after starting an auction). */
  async announceAuction(auctionId: string): Promise<void> {
    const state = await this.buildAuctionState(auctionId);
    if (state) await this.bus.publish(roomChannel(state.room), JSON.stringify(state.message));
  }

  /** Broadcast GIVEAWAY_OPEN to the room and arm the auto-draw at window close. */
  async announceGiveaway(giveawayId: string): Promise<void> {
    const g = await this.prisma.giveaway.findUnique({ where: { id: giveawayId } });
    if (!g || g.status !== 'OPEN') return;
    const sellerHandle = (await this.handleOf(g.sellerId)) ?? '';
    const count = await this.prisma.giveawayEntry.count({ where: { giveawayId } });
    const now = this.clock.now().getTime();
    const open: GiveawayOpenMessage = {
      type: 'GIVEAWAY_OPEN',
      room: g.sellerId,
      giveawayId,
      kind: normalizeGiveawayKind(g.kind),
      prize: g.prize,
      image: g.image,
      sellerHandle,
      opensAt: g.opensAt.getTime(),
      closesAt: g.closesAt.getTime(),
      entrantCount: count,
      seedHash: g.seedHash,
      serverNow: now,
    };
    await this.bus.publish(roomChannel(g.sellerId), JSON.stringify(open));
    this.scheduleGiveawayDraw(giveawayId, g.closesAt.getTime() - now);
  }

  /** Draw a giveaway now (auto at close, or the seller's manual "Draw") + reveal. */
  async drawGiveawayAndBroadcast(giveawayId: string): Promise<DrawResult> {
    const timer = this.giveawayTimers.get(giveawayId);
    if (timer) {
      clearTimeout(timer);
      this.giveawayTimers.delete(giveawayId);
    }
    const result = await drawGiveaway(giveawayId, this.clock, this.prisma);
    if (!result.ok) return result; // no entrants → the client's countdown shows "ended"
    const g = await this.prisma.giveaway.findUnique({
      where: { id: giveawayId },
      select: { sellerId: true },
    });
    if (!g) return result;
    const { roll, targetIndex } = buildRollOrder(result.entrants, result.winnerIndex);
    const now = this.clock.now().getTime();
    const msg: GiveawayWinnerMessage = {
      type: 'GIVEAWAY_WINNER',
      room: g.sellerId,
      giveawayId,
      kind: result.kind,
      prize: result.prize,
      image: result.image,
      winnerHandle: result.winner.handle,
      winnerUserId: result.winner.userId,
      entrantCount: result.entrants.length,
      roll,
      targetIndex,
      durationMs: 5200,
      startsAt: now + 400,
      seed: result.seed,
      seedHash: result.seedHash,
      serverNow: now,
    };
    await this.bus.publish(roomChannel(g.sellerId), JSON.stringify(msg));
    return result;
  }

  private scheduleGiveawayDraw(giveawayId: string, delayMs: number): void {
    const existing = this.giveawayTimers.get(giveawayId);
    if (existing) clearTimeout(existing);
    const t = setTimeout(() => void this.drawGiveawayAndBroadcast(giveawayId), Math.max(0, delayMs));
    if (typeof t.unref === 'function') t.unref(); // don't keep the process alive for it
    this.giveawayTimers.set(giveawayId, t);
  }

  private async handleGiveawayEnter(conn: Conn, msg: GiveawayEnterMessage): Promise<void> {
    if (!this.allow(conn.userId)) return; // silently drop spam taps
    const result = await enterGiveaway(msg.giveawayId, conn.userId, this.clock, this.prisma);
    if (!result.ok) {
      this.sendToConn(conn, {
        type: 'GIVEAWAY_REJECTED',
        giveawayId: msg.giveawayId,
        reason: result.reason,
      });
      return;
    }
    await this.broadcastEntries(msg.giveawayId);
  }

  private async broadcastEntries(giveawayId: string): Promise<void> {
    const g = await this.prisma.giveaway.findUnique({
      where: { id: giveawayId },
      select: { sellerId: true },
    });
    if (!g) return;
    const entrants = await listEntrants(giveawayId, this.prisma);
    const recent = entrants.slice(-14).reverse(); // newest first, for the avatar pile
    const msg: GiveawayEntriesMessage = {
      type: 'GIVEAWAY_ENTRIES',
      room: g.sellerId,
      giveawayId,
      count: entrants.length,
      recent,
      serverNow: this.clock.now().getTime(),
    };
    await this.bus.publish(roomChannel(g.sellerId), JSON.stringify(msg));
  }

  // ---- connection lifecycle ----------------------------------------------

  private onConnection(ws: WebSocket, req: http.IncomingMessage): void {
    const url = new URL(req.url ?? '', 'http://localhost');
    const userId = verifySession(url.searchParams.get('token'));
    if (!userId) {
      ws.close(4001, 'unauthorized');
      return;
    }
    const conn: Conn = { id: randomUUID(), ws, userId, rooms: new Set() };

    // Attach the message listener synchronously and buffer until setup finishes,
    // so a SUBSCRIBE sent the instant the socket opens is never dropped.
    const queue: RawData[] = [];
    let ready = false;
    ws.on('message', (data) => {
      if (ready) void this.onMessage(conn, data);
      else queue.push(data);
    });
    ws.on('close', () => void this.onDisconnect(conn));
    ws.on('error', () => {});

    void (async () => {
      const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { id: true } });
      if (!user) {
        ws.close(4001, 'unknown user');
        return;
      }
      this.conns.set(conn.id, conn);
      this.addLocal(this.localUsers, userId, conn.id);
      await this.ensureSub(userChannel(userId), (payload) => this.deliverToUser(userId, payload));
      ready = true;
      for (const data of queue) void this.onMessage(conn, data);
      queue.length = 0;
      void this.sendBalanceUpdate(userId);
    })();
  }

  private async onDisconnect(conn: Conn): Promise<void> {
    this.conns.delete(conn.id);
    this.removeLocal(this.localUsers, conn.userId, conn.id);
    await this.releaseSub(userChannel(conn.userId));
    for (const room of conn.rooms) {
      this.removeLocal(this.localRooms, room, conn.id);
      await this.releaseSub(roomChannel(room));
    }
  }

  private async onMessage(conn: Conn, data: RawData): Promise<void> {
    const msg = parseClientMessage(data.toString());
    if (!msg) {
      this.sendToConn(conn, { type: 'ERROR', message: 'malformed message' });
      return;
    }
    switch (msg.type) {
      case 'SUBSCRIBE':
        await this.handleSubscribe(conn, msg.room);
        break;
      case 'UNSUBSCRIBE':
        await this.handleUnsubscribe(conn, msg.room);
        break;
      case 'BID_INTENT':
        await this.handleBidIntent(conn, msg);
        break;
      case 'GIVEAWAY_ENTER':
        await this.handleGiveawayEnter(conn, msg);
        break;
    }
  }

  // ---- message handlers ---------------------------------------------------

  private async handleSubscribe(conn: Conn, room: string): Promise<void> {
    const firstSubscribe = !conn.rooms.has(room);
    if (firstSubscribe) {
      conn.rooms.add(room);
      this.addLocal(this.localRooms, room, conn.id);
      await this.ensureSub(roomChannel(room), (payload) => this.deliverToRoom(room, payload));
    }
    const auctions = await this.prisma.auction.findMany({
      where: { status: AuctionStatus.RUNNING, listing: { sellerId: room } },
      select: { id: true },
    });
    for (const { id } of auctions) {
      const state = await this.buildAuctionState(id);
      if (state) this.sendToConn(conn, state.message);
    }
    // Catch-up: a client whose socket blipped right as the clock hit zero reconnects
    // on a NEW connection and won't see that auction above (it's no longer RUNNING) —
    // it would sit on a frozen timer, never learning who won. On that connection's
    // first subscribe, replay the most-recent close so it can sync the result. Gated
    // to the first subscribe so the 12s heartbeat re-subscribes don't re-fire it.
    // Flagged `replay` so the client surfaces the winner without re-firing the
    // full-screen celebration meant for people who were actually watching.
    if (firstSubscribe && auctions.length === 0) {
      const cutoff = new Date(this.clock.now().getTime() - CLOSE_REPLAY_WINDOW_MS);
      const recent = await this.prisma.auction.findFirst({
        where: {
          listing: { sellerId: room },
          status: { in: [AuctionStatus.SETTLING, AuctionStatus.CLOSED] },
          endsAt: { gte: cutoff },
        },
        orderBy: { endsAt: 'desc' },
        select: { id: true, currentBid: true, currentLeaderUserId: true },
      });
      if (recent) {
        const winnerHandle = recent.currentLeaderUserId
          ? await this.handleOf(recent.currentLeaderUserId)
          : null;
        const amount =
          winnerHandle && recent.currentBid !== null ? formatUsdc(recent.currentBid) : null;
        const replay: AuctionClosedMessage = {
          type: 'AUCTION_CLOSED',
          room,
          auctionId: recent.id,
          winnerHandle,
          amount,
          wheel: false,
          replay: true,
          serverNow: this.clock.now().getTime(),
        };
        this.sendToConn(conn, replay);
      }
    }
  }

  private async handleUnsubscribe(conn: Conn, room: string): Promise<void> {
    if (!conn.rooms.has(room)) return;
    conn.rooms.delete(room);
    this.removeLocal(this.localRooms, room, conn.id);
    await this.releaseSub(roomChannel(room));
  }

  private async handleBidIntent(conn: Conn, msg: BidIntentMessage): Promise<void> {
    if (!this.allow(conn.userId)) {
      this.sendToConn(conn, {
        type: 'BID_REJECTED',
        auctionId: msg.auctionId,
        clientNonce: msg.clientNonce,
        reason: RealtimeRejectReason.RATE_LIMITED,
      });
      return;
    }

    let amount: bigint;
    try {
      amount = usdc(msg.amount);
    } catch {
      this.sendToConn(conn, { type: 'ERROR', message: 'invalid amount' });
      return;
    }

    const result = await placeBid(
      { auctionId: msg.auctionId, userId: conn.userId, amount },
      this.clock,
      this.prisma,
    );

    if (!result.ok) {
      this.sendToConn(conn, {
        type: 'BID_REJECTED',
        auctionId: msg.auctionId,
        clientNonce: msg.clientNonce,
        reason: result.reason,
      });
      return;
    }

    const state = await this.buildAuctionState(msg.auctionId);
    if (state) {
      const leaderHandle = (await this.handleOf(conn.userId)) ?? '';
      const accepted: BidAcceptedMessage = {
        type: 'BID_ACCEPTED',
        room: state.room,
        auctionId: msg.auctionId,
        amount: formatUsdc(amount),
        leaderHandle,
        extended: result.extended,
        endsAt: state.message.endsAt,
        serverNow: this.clock.now().getTime(),
      };
      await this.bus.publish(roomChannel(state.room), JSON.stringify(accepted));
      await this.bus.publish(roomChannel(state.room), JSON.stringify(state.message));
    }

    await this.sendBalanceUpdate(conn.userId);
    if (result.previousLeaderUserId && result.previousLeaderUserId !== conn.userId) {
      await this.sendBalanceUpdate(result.previousLeaderUserId);
    }
  }

  // ---- closing ------------------------------------------------------------

  private async onAuctionsClosed(results: CloseResult[]): Promise<void> {
    for (const result of results) {
      const auction = await this.prisma.auction.findUnique({
        where: { id: result.auctionId },
        include: { listing: { select: { sellerId: true, wheel: true } } },
      });
      if (!auction) continue;

      // Settle the win: direct payout (100% to seller, no escrow/fee) when that
      // mode is on, otherwise the escrow flow (LOCKED order + 95/5 on release).
      if (result.winnerUserId) {
        try {
          if (this.directPayout) {
            await settleAuctionDirect(result.auctionId, this.clock, this.prisma);
          } else if (this.escrow) {
            await settleAuction(result.auctionId, this.escrow, this.clock, this.prisma);
          }
        } catch (err) {
          console.error('[settle]', err);
        }
      }

      const room = auction.listing.sellerId;
      const winnerHandle = result.winnerUserId ? await this.handleOf(result.winnerUserId) : null;
      const amount =
        result.winnerUserId && auction.currentBid !== null ? formatUsdc(auction.currentBid) : null;

      // A wheel auction with a winner defers its celebration to the spin: the
      // server decides the slot here and broadcasts the reel for everyone to
      // replay. Clients see `wheel: true` and wait for the RANDOMIZER_SPIN.
      const entries = parseWheel(auction.listing.wheel);
      const spin =
        entries && winnerHandle && amount
          ? this.buildSpin(room, result.auctionId, entries, winnerHandle, amount)
          : null;

      const closed: AuctionClosedMessage = {
        type: 'AUCTION_CLOSED',
        room,
        auctionId: result.auctionId,
        winnerHandle,
        amount,
        wheel: spin !== null,
        serverNow: this.clock.now().getTime(),
      };
      await this.bus.publish(roomChannel(room), JSON.stringify(closed));
      if (spin) await this.bus.publish(roomChannel(room), JSON.stringify(spin));
      const state = await this.buildAuctionState(result.auctionId);
      if (state) await this.bus.publish(roomChannel(room), JSON.stringify(state.message));
    }
  }

  /** Decide the wheel outcome server-side and package the reel for broadcast. */
  private buildSpin(
    room: string,
    auctionId: string,
    entries: WheelEntry[],
    winnerHandle: string,
    amount: string,
  ): RandomizerSpinMessage {
    const seed = randomBytes(16).toString('hex');
    const seedHash = createHash('sha256').update(seed).digest('hex');
    const prizeIndex = pickSlot(entries, seed);
    const { reel, targetIndex } = buildReel(entries, prizeIndex);
    const now = this.clock.now().getTime();
    return {
      type: 'RANDOMIZER_SPIN',
      room,
      auctionId,
      winnerHandle,
      amount,
      reel,
      targetIndex,
      durationMs: 5200,
      startsAt: now + 400, // small lead so every client arms before it starts
      seedHash,
      serverNow: now,
    };
  }

  // ---- builders & senders -------------------------------------------------

  private async buildAuctionState(
    auctionId: string,
  ): Promise<{ room: string; message: AuctionStateMessage } | null> {
    const auction = await this.prisma.auction.findUnique({
      where: { id: auctionId },
      include: { listing: { select: { sellerId: true, title: true, photos: true, wheel: true } } },
    });
    if (!auction) return null;
    const wheel = parseWheel(auction.listing.wheel);
    const now = this.clock.now();
    const cfg: IncrementConfig = {
      floor: auction.minIncrementFloor,
      bps: BigInt(auction.minIncrementBps),
    };
    const leaderHandle = auction.currentLeaderUserId
      ? await this.handleOf(auction.currentLeaderUserId)
      : null;
    const room = auction.listing.sellerId;
    const message: AuctionStateMessage = {
      type: 'AUCTION_STATE',
      room,
      auctionId,
      listingId: auction.listingId,
      title: auction.listing.title,
      imageUrl: auction.listing.photos[0] ?? null,
      status: auction.status,
      currentBid: auction.currentBid !== null ? formatUsdc(auction.currentBid) : null,
      leaderHandle,
      minNextBid: formatUsdc(minNextBid(auction.currentBid, auction.startingBid, cfg)),
      durationSeconds: auction.durationSeconds,
      endsAt: auction.endsAt ? auction.endsAt.getTime() : null,
      ...(wheel ? { wheel } : {}),
      serverNow: now.getTime(),
    };
    return { room, message };
  }

  private async sendBalanceUpdate(userId: string): Promise<void> {
    const account = await this.prisma.account.findUnique({
      where: { userId },
      select: { id: true },
    });
    if (!account) return;
    const [settled, available] = await Promise.all([
      getSettledBalance(account.id, this.prisma),
      getAvailableBalance(account.id, this.prisma),
    ]);
    const message: BalanceUpdateMessage = {
      type: 'BALANCE_UPDATE',
      available: formatUsdc(available),
      settled: formatUsdc(settled),
    };
    await this.bus.publish(userChannel(userId), JSON.stringify(message));
  }

  private async handleOf(userId: string): Promise<string | null> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { handle: true },
    });
    return user?.handle ?? null;
  }

  private sendToConn(conn: Conn, message: ServerMessage): void {
    if (conn.ws.readyState === WebSocket.OPEN) conn.ws.send(JSON.stringify(message));
  }

  private deliverToRoom(room: string, payload: string): void {
    for (const id of this.localRooms.get(room) ?? []) {
      const conn = this.conns.get(id);
      if (conn && conn.ws.readyState === WebSocket.OPEN) conn.ws.send(payload);
    }
  }

  private deliverToUser(userId: string, payload: string): void {
    for (const id of this.localUsers.get(userId) ?? []) {
      const conn = this.conns.get(id);
      if (conn && conn.ws.readyState === WebSocket.OPEN) conn.ws.send(payload);
    }
  }

  // ---- bus subscription ref-counting & local membership ------------------

  private async ensureSub(channel: string, handler: BusHandler): Promise<void> {
    const existing = this.busSubs.get(channel);
    if (existing) {
      existing.refCount += 1;
      return;
    }
    const unsub = await this.bus.subscribe(channel, handler);
    this.busSubs.set(channel, { unsub, refCount: 1 });
  }

  private async releaseSub(channel: string): Promise<void> {
    const existing = this.busSubs.get(channel);
    if (!existing) return;
    existing.refCount -= 1;
    if (existing.refCount <= 0) {
      this.busSubs.delete(channel);
      await existing.unsub().catch(() => {});
    }
  }

  private addLocal(map: Map<string, Set<string>>, key: string, id: string): void {
    let set = map.get(key);
    if (!set) {
      set = new Set();
      map.set(key, set);
    }
    set.add(id);
  }

  private removeLocal(map: Map<string, Set<string>>, key: string, id: string): void {
    const set = map.get(key);
    if (!set) return;
    set.delete(id);
    if (set.size === 0) map.delete(key);
  }

  private allow(userId: string): boolean {
    const now = Date.now();
    const recent = (this.rate.get(userId) ?? []).filter((t) => now - t < 1000);
    if (recent.length >= this.rateLimitPerSec) {
      this.rate.set(userId, recent);
      return false;
    }
    recent.push(now);
    this.rate.set(userId, recent);
    return true;
  }
}

/** Validate a listing's stored `wheel` JSON into prize entries, or null. */
function parseWheel(raw: unknown): WheelEntry[] | null {
  const entries = normalizeWheelEntries(raw);
  return entries.length > 0 ? entries : null;
}
