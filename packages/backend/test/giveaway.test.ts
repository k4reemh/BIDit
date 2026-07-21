import { describe, it, expect, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';
import { prisma } from '../src/db.js';
import {
  usdc,
  pickWinnerIndex,
  buildRollOrder,
  normalizeGiveawayKind,
  type GiveawayEntrant,
} from '@bidit/shared';
import { createAuction } from '../src/auction.js';
import {
  openGiveaway,
  enterGiveaway,
  drawGiveaway,
  isEligible,
  listEntrants,
} from '../src/giveaways.js';
import { ManualClock } from '../src/clock.js';
import { resetDb, makeUser } from './setup.js';

/** Give `buyerId` a real purchase from `sellerId` (for BUYER_ONLY eligibility). */
async function makePurchase(sellerId: string, buyerId: string): Promise<void> {
  const listing = await prisma.listing.create({
    data: { sellerId, title: 'Sold card', photos: [], startingBid: usdc('1'), status: 'SOLD' },
  });
  const auctionId = await createAuction({ listingId: listing.id, startingBid: usdc('1') }, prisma);
  await prisma.order.create({
    data: {
      auctionId,
      buyerId,
      sellerId,
      amount: usdc('10'),
      platformFee: usdc('0.5'),
      sellerProceeds: usdc('9.5'),
    },
  });
}

beforeEach(async () => {
  await resetDb();
});

// ---- shared deterministic core (pure) ---------------------------------------

describe('giveaway winner selection (pure)', () => {
  it('pickWinnerIndex is deterministic and in range', () => {
    for (const n of [1, 2, 5, 37, 100]) {
      const i = pickWinnerIndex(n, 'deadbeefcafe');
      expect(i).toBeGreaterThanOrEqual(0);
      expect(i).toBeLessThan(n);
      expect(pickWinnerIndex(n, 'deadbeefcafe')).toBe(i); // same seed → same index
    }
  });

  it('different seeds spread the winner across the field', () => {
    const seen = new Set<number>();
    for (let k = 0; k < 40; k++) seen.add(pickWinnerIndex(10, `seed-${k}`));
    expect(seen.size).toBeGreaterThan(4); // not stuck on one slot
  });

  it('buildRollOrder lands the target on the winner', () => {
    const entrants: GiveawayEntrant[] = Array.from({ length: 6 }, (_, i) => ({
      userId: `u${i}`,
      handle: `h${i}`,
    }));
    const { roll, targetIndex } = buildRollOrder(entrants, 3);
    expect(roll.length % entrants.length).toBe(0);
    expect(roll.length).toBeGreaterThan(entrants.length * 3);
    expect(roll[targetIndex]).toEqual(entrants[3]); // spotlight settles on the winner
  });

  it('normalizeGiveawayKind defaults to PUBLIC', () => {
    expect(normalizeGiveawayKind('BUYER_ONLY')).toBe('BUYER_ONLY');
    expect(normalizeGiveawayKind('PUBLIC')).toBe('PUBLIC');
    expect(normalizeGiveawayKind('garbage')).toBe('PUBLIC');
    expect(normalizeGiveawayKind(undefined)).toBe('PUBLIC');
  });
});

// ---- open + commit ----------------------------------------------------------

describe('openGiveaway', () => {
  it('opens with a committed seed hash and an entry window', async () => {
    const seller = await makeUser('seller');
    const clock = new ManualClock(Date.now());
    const g = await openGiveaway(
      seller.userId,
      { kind: 'PUBLIC', prize: 'Charizard slab', durationMs: 30_000 },
      clock,
      prisma,
    );
    expect(g.status).toBe('OPEN');
    expect(g.kind).toBe('PUBLIC');
    expect(g.seedHash).toMatch(/^[0-9a-f]{64}$/);
    expect(createHash('sha256').update(g.seed).digest('hex')).toBe(g.seedHash); // commit is honest
    expect(g.closesAt.getTime() - g.opensAt.getTime()).toBe(30_000);
  });

  it('rejects a blank prize', async () => {
    const seller = await makeUser('seller');
    await expect(
      openGiveaway(seller.userId, { kind: 'PUBLIC', prize: '   ' }, new ManualClock(), prisma),
    ).rejects.toThrow();
  });

  it('strips control chars and caps the prize length (XSS/broadcast hardening)', async () => {
    const seller = await makeUser('seller');
    // A payload-shaped prize with newlines/control chars + an over-long tail.
    const nasty = 'win\n\t<img src=x onerror=alert(1)>' + 'A'.repeat(200);
    const g = await openGiveaway(seller.userId, { kind: 'PUBLIC', prize: nasty }, new ManualClock(), prisma);
    expect(g.prize.length).toBeLessThanOrEqual(80);
    expect(g.prize).not.toContain('\n');
    expect(g.prize).not.toContain('\t');
    // still stored as literal text (defanged at render via textContent, not here)
    expect(g.prize.startsWith('win <img')).toBe(true);
  });
});

// ---- entry: public vs buyer-only --------------------------------------------

describe('entering a public giveaway', () => {
  it('lets any viewer enter and is idempotent', async () => {
    const seller = await makeUser('seller');
    const a = await makeUser('buyer');
    const b = await makeUser('buyer');
    const clock = new ManualClock(Date.now());
    const g = await openGiveaway(seller.userId, { kind: 'PUBLIC', prize: 'Pack' }, clock, prisma);

    const r1 = await enterGiveaway(g.id, a.userId, clock, prisma);
    const r2 = await enterGiveaway(g.id, b.userId, clock, prisma);
    expect(r1).toEqual({ ok: true, count: 1, alreadyEntered: false });
    expect(r2).toEqual({ ok: true, count: 2, alreadyEntered: false });

    const again = await enterGiveaway(g.id, a.userId, clock, prisma);
    expect(again).toEqual({ ok: true, count: 2, alreadyEntered: true }); // no double count
  });
});

describe('entering a buyer-only giveaway', () => {
  it('allows buyers of this seller and rejects everyone else', async () => {
    const seller = await makeUser('seller');
    const buyer = await makeUser('buyer');
    const lurker = await makeUser('buyer');
    await makePurchase(seller.userId, buyer.userId); // buyer bought from this seller

    const clock = new ManualClock(Date.now());
    const g = await openGiveaway(seller.userId, { kind: 'BUYER_ONLY', prize: 'Slab' }, clock, prisma);

    expect(await isEligible(g, buyer.userId, prisma)).toBe(true);
    expect(await isEligible(g, lurker.userId, prisma)).toBe(false);

    const ok = await enterGiveaway(g.id, buyer.userId, clock, prisma);
    expect(ok.ok).toBe(true);
    const denied = await enterGiveaway(g.id, lurker.userId, clock, prisma);
    expect(denied).toEqual({ ok: false, reason: 'NOT_ELIGIBLE' });
  });

  it("a purchase from a DIFFERENT seller doesn't qualify", async () => {
    const seller = await makeUser('seller');
    const otherSeller = await makeUser('seller');
    const buyer = await makeUser('buyer');
    await makePurchase(otherSeller.userId, buyer.userId); // bought elsewhere

    const g = await openGiveaway(seller.userId, { kind: 'BUYER_ONLY', prize: 'Slab' }, new ManualClock(), prisma);
    expect(await isEligible(g, buyer.userId, prisma)).toBe(false);
  });
});

describe('the entry window', () => {
  it('refuses entries once the window has closed', async () => {
    const seller = await makeUser('seller');
    const viewer = await makeUser('buyer');
    const clock = new ManualClock(Date.now());
    const g = await openGiveaway(seller.userId, { kind: 'PUBLIC', prize: 'x', durationMs: 10_000 }, clock, prisma);

    clock.advance(11_000); // past closesAt
    expect(await enterGiveaway(g.id, viewer.userId, clock, prisma)).toEqual({ ok: false, reason: 'CLOSED' });
  });
});

// ---- draw -------------------------------------------------------------------

describe('drawing the winner', () => {
  it('picks a real entrant, deterministically, and is idempotent', async () => {
    const seller = await makeUser('seller');
    const clock = new ManualClock(Date.now());
    const g = await openGiveaway(seller.userId, { kind: 'PUBLIC', prize: 'Booster box' }, clock, prisma);

    const viewers = [];
    for (let i = 0; i < 8; i++) {
      const v = await makeUser('buyer');
      viewers.push(v);
      await enterGiveaway(g.id, v.userId, clock, prisma);
    }

    const result = await drawGiveaway(g.id, clock, prisma);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Winner is one of the entrants...
    const entrantIds = result.entrants.map((e) => e.userId);
    expect(entrantIds).toContain(result.winner.userId);
    // ...and is exactly what the committed seed re-derives (provably fair).
    const reIndex = pickWinnerIndex(result.entrants.length, result.seed);
    expect(result.entrants[reIndex]!.userId).toBe(result.winner.userId);
    expect(createHash('sha256').update(result.seed).digest('hex')).toBe(result.seedHash);

    // Persisted + idempotent.
    const stored = await prisma.giveaway.findUniqueOrThrow({ where: { id: g.id } });
    expect(stored.status).toBe('CLOSED');
    expect(stored.winnerUserId).toBe(result.winner.userId);
    const again = await drawGiveaway(g.id, clock, prisma);
    expect(again.ok && again.winner.userId).toBe(result.winner.userId);
  });

  it('reports no winner when nobody entered, and closes the giveaway', async () => {
    const seller = await makeUser('seller');
    const clock = new ManualClock(Date.now());
    const g = await openGiveaway(seller.userId, { kind: 'PUBLIC', prize: 'nobody wants this' }, clock, prisma);

    const result = await drawGiveaway(g.id, clock, prisma);
    expect(result).toEqual({ ok: false, reason: 'NO_ENTRANTS' });
    const stored = await prisma.giveaway.findUniqueOrThrow({ where: { id: g.id } });
    expect(stored.status).toBe('CLOSED');
    expect(stored.winnerUserId).toBeNull();

    // A closed giveaway no longer accepts entries.
    const late = await makeUser('buyer');
    expect(await enterGiveaway(g.id, late.userId, clock, prisma)).toEqual({ ok: false, reason: 'NOT_OPEN' });
  });

  it('listEntrants returns a stable ordering with handles', async () => {
    const seller = await makeUser('seller');
    const clock = new ManualClock(Date.now());
    const g = await openGiveaway(seller.userId, { kind: 'PUBLIC', prize: 'x' }, clock, prisma);
    const v1 = await makeUser('buyer');
    const v2 = await makeUser('buyer');
    await enterGiveaway(g.id, v1.userId, clock, prisma);
    await enterGiveaway(g.id, v2.userId, clock, prisma);

    const entrants = await listEntrants(g.id, prisma);
    expect(entrants.map((e) => e.handle)).toEqual([v1.handle, v2.handle]);
    expect(await listEntrants(g.id, prisma)).toEqual(entrants); // stable across calls
  });
});
