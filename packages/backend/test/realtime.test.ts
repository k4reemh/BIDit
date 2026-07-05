import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { WebSocket } from 'ws';
import { prisma } from '../src/db.js';
import { ManualClock } from '../src/clock.js';
import { RealtimeServer } from '../src/realtime/server.js';
import { InMemoryBus } from '../src/realtime/bus.js';
import { issueSession } from '../src/auth.js';
import { BidRejectReason, RealtimeRejectReason } from '@bidit/shared';
import { resetDb, makeFundedUser, makeRunningAuction } from './setup.js';

const T0 = new Date('2026-01-01T00:00:00.000Z').getTime();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A WebSocket client that buffers messages and lets tests await by type. */
class TestClient {
  readonly ws: WebSocket;
  private buf: Array<Record<string, unknown>> = [];
  private listeners = new Set<() => void>();

  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.on('message', (data) => {
      this.buf.push(JSON.parse(data.toString()));
      for (const fn of [...this.listeners]) fn();
    });
  }

  open(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws.on('open', () => resolve());
      this.ws.on('error', reject);
    });
  }

  send(obj: unknown): void {
    this.ws.send(JSON.stringify(obj));
  }

  waitFor(type: string, timeout = 2000): Promise<Record<string, any>> {
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        this.listeners.delete(check);
      };
      const check = () => {
        const i = this.buf.findIndex((m) => m.type === type);
        if (i >= 0) {
          const [m] = this.buf.splice(i, 1);
          cleanup();
          resolve(m as Record<string, any>);
        }
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`timeout waiting for ${type}`));
      }, timeout);
      this.listeners.add(check);
      check();
    });
  }

  drain(type: string): Array<Record<string, any>> {
    const out = this.buf.filter((m) => m.type === type);
    this.buf = this.buf.filter((m) => m.type !== type);
    return out as Array<Record<string, any>>;
  }

  async expectNone(type: string, withinMs = 300): Promise<void> {
    await sleep(withinMs);
    expect(this.buf.find((m) => m.type === type)).toBeUndefined();
  }

  close(): void {
    this.ws.close();
  }
}

let server: RealtimeServer;
let port: number;
const url = (token: string) => `ws://127.0.0.1:${port}/ws?token=${encodeURIComponent(token)}`;

async function startServer(clock: ManualClock, rateLimitPerSec = 100): Promise<void> {
  server = new RealtimeServer({ prisma, bus: new InMemoryBus(), clock, rateLimitPerSec });
  port = await server.listen(0);
}

beforeEach(async () => {
  await resetDb();
});

afterEach(async () => {
  await server.close();
});

describe('two tabs stay in sync and bid against each other', () => {
  it('broadcasts accepts to the room, rejects only to the bidder, balances live', async () => {
    const clock = new ManualClock(T0);
    await startServer(clock);
    const auction = await makeRunningAuction({ startingBid: '5', clock, durationSeconds: 60 });
    const a = await makeFundedUser('100');
    const b = await makeFundedUser('100');

    const ca = new TestClient(url(issueSession(a.userId)));
    const cb = new TestClient(url(issueSession(b.userId)));
    await ca.open();
    await cb.open();
    await ca.waitFor('BALANCE_UPDATE');
    await cb.waitFor('BALANCE_UPDATE');

    ca.send({ type: 'SUBSCRIBE', room: auction.sellerId });
    cb.send({ type: 'SUBSCRIBE', room: auction.sellerId });
    const stateA = await ca.waitFor('AUCTION_STATE');
    await cb.waitFor('AUCTION_STATE');
    expect(stateA.currentBid).toBeNull();
    expect(stateA.minNextBid).toBe('5');
    expect(stateA.title).toBe('Charizard Holo');
    expect(stateA.imageUrl).toBeNull();

    // A bids $10 -> both tabs see it; A's balance drops to $90.
    ca.send({ type: 'BID_INTENT', auctionId: auction.auctionId, amount: '10', clientNonce: 'n1' });
    const accA = await ca.waitFor('BID_ACCEPTED');
    const accB = await cb.waitFor('BID_ACCEPTED');
    expect(accA.amount).toBe('10');
    expect(accA.leaderHandle).toBe(a.handle);
    expect(accB.leaderHandle).toBe(a.handle);
    expect((await ca.waitFor('BALANCE_UPDATE')).available).toBe('90');
    await ca.waitFor('AUCTION_STATE');
    await cb.waitFor('AUCTION_STATE');

    // B outbids at $11 -> leader flips; A is freed back to $100, B drops to $89.
    cb.send({ type: 'BID_INTENT', auctionId: auction.auctionId, amount: '11', clientNonce: 'n2' });
    await ca.waitFor('BID_ACCEPTED');
    const accB2 = await cb.waitFor('BID_ACCEPTED');
    expect(accB2.leaderHandle).toBe(b.handle);
    expect((await ca.waitFor('BALANCE_UPDATE')).available).toBe('100');
    expect((await cb.waitFor('BALANCE_UPDATE')).available).toBe('89');

    // A bids $11 (below the $12 min next) -> only A is told, with a precise reason.
    ca.send({ type: 'BID_INTENT', auctionId: auction.auctionId, amount: '11', clientNonce: 'n3' });
    const rej = await ca.waitFor('BID_REJECTED');
    expect(rej.reason).toBe(BidRejectReason.BID_TOO_LOW);
    expect(rej.clientNonce).toBe('n3');
    await cb.expectNone('BID_REJECTED');

    ca.close();
    cb.close();
  });
});

describe('rate limiting', () => {
  it('rejects bursts of BID_INTENT beyond the per-user limit', async () => {
    const clock = new ManualClock(T0);
    await startServer(clock, 3); // 3 intents/sec
    const auction = await makeRunningAuction({ startingBid: '5', clock, durationSeconds: 60 });
    const a = await makeFundedUser('1000');

    const ca = new TestClient(url(issueSession(a.userId)));
    await ca.open();
    await ca.waitFor('BALANCE_UPDATE');
    ca.send({ type: 'SUBSCRIBE', room: auction.sellerId });
    await ca.waitFor('AUCTION_STATE');

    for (let i = 0; i < 8; i++) {
      ca.send({ type: 'BID_INTENT', auctionId: auction.auctionId, amount: '5', clientNonce: `r${i}` });
    }
    await sleep(400);
    const rejects = ca.drain('BID_REJECTED');
    const rateLimited = rejects.filter((r) => r.reason === RealtimeRejectReason.RATE_LIMITED);
    expect(rateLimited.length).toBeGreaterThanOrEqual(1);

    ca.close();
  });
});

describe('server-driven close broadcast', () => {
  it('tells the room who won when the deadline passes', async () => {
    const clock = new ManualClock(T0);
    await startServer(clock);
    const auction = await makeRunningAuction({ startingBid: '5', clock, durationSeconds: 20 });
    const a = await makeFundedUser('100');

    const ca = new TestClient(url(issueSession(a.userId)));
    await ca.open();
    await ca.waitFor('BALANCE_UPDATE');
    ca.send({ type: 'SUBSCRIBE', room: auction.sellerId });
    await ca.waitFor('AUCTION_STATE');

    ca.send({ type: 'BID_INTENT', auctionId: auction.auctionId, amount: '10', clientNonce: 'x' });
    await ca.waitFor('BID_ACCEPTED');

    clock.advance(21_000);
    await server.tickScheduler();

    const closed = await ca.waitFor('AUCTION_CLOSED');
    expect(closed.winnerHandle).toBe(a.handle);
    expect(closed.amount).toBe('10');

    ca.close();
  });
});

describe('catch-up replay for a client that missed the live close', () => {
  it('replays the recent result to a (re)subscriber so the timer never freezes', async () => {
    const clock = new ManualClock(T0);
    await startServer(clock);
    const auction = await makeRunningAuction({ startingBid: '5', clock, durationSeconds: 20 });
    const a = await makeFundedUser('100');

    // First client bids, then the auction closes with the live broadcast.
    const ca = new TestClient(url(issueSession(a.userId)));
    await ca.open();
    await ca.waitFor('BALANCE_UPDATE');
    ca.send({ type: 'SUBSCRIBE', room: auction.sellerId });
    await ca.waitFor('AUCTION_STATE');
    ca.send({ type: 'BID_INTENT', auctionId: auction.auctionId, amount: '10', clientNonce: 'x' });
    await ca.waitFor('BID_ACCEPTED');
    clock.advance(21_000);
    await server.tickScheduler();
    await ca.waitFor('AUCTION_CLOSED');
    ca.close();

    // A second client subscribes AFTER the close — as if it reconnected right as the
    // clock hit zero and missed the one-shot event. It must still learn who won,
    // flagged `replay` so the client syncs quietly (no full-screen celebration).
    const b = await makeFundedUser('50');
    const cb = new TestClient(url(issueSession(b.userId)));
    await cb.open();
    await cb.waitFor('BALANCE_UPDATE');
    cb.send({ type: 'SUBSCRIBE', room: auction.sellerId });

    const replay = await cb.waitFor('AUCTION_CLOSED');
    expect(replay.replay).toBe(true);
    expect(replay.wheel).toBe(false);
    expect(replay.winnerHandle).toBe(a.handle);
    expect(replay.amount).toBe('10');

    // A heartbeat re-subscribe on the SAME connection must NOT re-fire the replay,
    // or a viewer parked on a closed room would get spammed every 12s.
    cb.send({ type: 'SUBSCRIBE', room: auction.sellerId });
    await cb.expectNone('AUCTION_CLOSED');

    cb.close();
  });

  it('does not replay a close that is older than the catch-up window', async () => {
    const clock = new ManualClock(T0);
    await startServer(clock);
    const auction = await makeRunningAuction({ startingBid: '5', clock, durationSeconds: 20 });
    const a = await makeFundedUser('100');

    const ca = new TestClient(url(issueSession(a.userId)));
    await ca.open();
    await ca.waitFor('BALANCE_UPDATE');
    ca.send({ type: 'SUBSCRIBE', room: auction.sellerId });
    await ca.waitFor('AUCTION_STATE');
    ca.send({ type: 'BID_INTENT', auctionId: auction.auctionId, amount: '10', clientNonce: 'x' });
    await ca.waitFor('BID_ACCEPTED');
    clock.advance(21_000);
    await server.tickScheduler();
    await ca.waitFor('AUCTION_CLOSED');
    ca.close();

    // Long after the close, a fresh subscriber should NOT be popped with a stale win.
    clock.advance(120_000);
    const b = await makeFundedUser('50');
    const cb = new TestClient(url(issueSession(b.userId)));
    await cb.open();
    await cb.waitFor('BALANCE_UPDATE');
    cb.send({ type: 'SUBSCRIBE', room: auction.sellerId });
    await cb.expectNone('AUCTION_CLOSED');

    cb.close();
  });
});

describe('wheel-spin randomizer (bid to win a roll)', () => {
  const WHEEL = [
    { label: 'Charizard ex — Alt Art', tier: 'Chase' },
    { label: 'Sealed Booster Box', tier: 'Box' },
    { label: 'Single Booster Pack', tier: 'Pack' },
  ];

  it('spins the wheel after a win — and never before the auction closes', async () => {
    const clock = new ManualClock(T0);
    await startServer(clock);
    const auction = await makeRunningAuction({ startingBid: '5', clock, durationSeconds: 20 });
    await prisma.listing.update({ where: { id: auction.listingId }, data: { wheel: WHEEL } });
    const a = await makeFundedUser('100');

    const ca = new TestClient(url(issueSession(a.userId)));
    await ca.open();
    await ca.waitFor('BALANCE_UPDATE');
    ca.send({ type: 'SUBSCRIBE', room: auction.sellerId });
    await ca.waitFor('AUCTION_STATE');

    ca.send({ type: 'BID_INTENT', auctionId: auction.auctionId, amount: '10', clientNonce: 'x' });
    await ca.waitFor('BID_ACCEPTED');

    // The wheel must NOT spin while bidding is live.
    await ca.expectNone('RANDOMIZER_SPIN');

    clock.advance(21_000);
    await server.tickScheduler();

    // Close comes first, flagged as a wheel auction so clients defer the reveal...
    const closed = await ca.waitFor('AUCTION_CLOSED');
    expect(closed.winnerHandle).toBe(a.handle);
    expect(closed.wheel).toBe(true);

    // ...then the single spin everyone replays in lockstep.
    const spin = await ca.waitFor('RANDOMIZER_SPIN');
    expect(spin.winnerHandle).toBe(a.handle);
    expect(spin.amount).toBe('10');
    expect(Array.isArray(spin.reel)).toBe(true);
    expect(spin.reel.length).toBeGreaterThan(3);
    expect(spin.targetIndex).toBeGreaterThanOrEqual(0);
    expect(spin.targetIndex).toBeLessThan(spin.reel.length);
    // the slot it lands on is one of the seller's configured prizes
    expect(WHEEL.map((e) => e.label)).toContain(spin.reel[spin.targetIndex].label);
    expect(typeof spin.seedHash).toBe('string');
    expect(spin.startsAt).toBeGreaterThanOrEqual(spin.serverNow);

    ca.close();
  });

  it('does not spin when the auction closes with no bidder (no winner = no prize)', async () => {
    const clock = new ManualClock(T0);
    await startServer(clock);
    const auction = await makeRunningAuction({ startingBid: '5', clock, durationSeconds: 20 });
    await prisma.listing.update({ where: { id: auction.listingId }, data: { wheel: WHEEL } });
    const a = await makeFundedUser('100');

    const ca = new TestClient(url(issueSession(a.userId)));
    await ca.open();
    await ca.waitFor('BALANCE_UPDATE');
    ca.send({ type: 'SUBSCRIBE', room: auction.sellerId });
    await ca.waitFor('AUCTION_STATE');

    clock.advance(21_000);
    await server.tickScheduler();

    const closed = await ca.waitFor('AUCTION_CLOSED');
    expect(closed.winnerHandle).toBeNull();
    expect(closed.wheel).toBeFalsy();
    await ca.expectNone('RANDOMIZER_SPIN');

    ca.close();
  });
});
