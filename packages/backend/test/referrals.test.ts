import { describe, it, expect, beforeEach } from 'vitest';
import { prisma } from '../src/db.js';
import { ManualClock } from '../src/clock.js';
import { DevWalletEscrow } from '../src/escrow.js';
import { createMarketListing, buyMarketItem } from '../src/market.js';
import {
  getOrCreateReferralCode,
  applyReferralAtSignup,
  getReferralInfo,
  referralLeaders,
} from '../src/referrals.js';
import { qualifyReferral, getPointsSummary, REFERRER_POINTS, REFEREE_POINTS } from '../src/points.js';
import { usdc } from '@bidit/shared';
import { applyAsSeller } from '../src/authz.js';
import { resetDb, makeFundedUser, makeUser } from './setup.js';

const T0 = new Date('2026-03-01T00:00:00.000Z').getTime();
const escrow = new DevWalletEscrow(prisma);
const PHOTO = 'data:image/jpeg;base64,aGVsbG8=';
const US_ADDR = { name: 'Al', line1: '1 Main St', city: 'NYC', region: 'NY', postal: '10001', country: 'US' };

beforeEach(async () => { await resetDb(); });

async function pointsOf(userId: string): Promise<bigint> {
  return (await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { points: true } })).points;
}

describe('referral codes', () => {
  it('vanity code from the handle, immutable, collision gets a suffix', async () => {
    const a = await makeUser('buyer');
    const code = await getOrCreateReferralCode(a.userId, prisma);
    expect(code).toBe(a.handle.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 20));
    expect(await getOrCreateReferralCode(a.userId, prisma)).toBe(code); // immutable

    // Force a collision: give b the same handle-base by stealing the code.
    const b = await makeUser('buyer');
    await prisma.user.update({ where: { id: b.userId }, data: { handle: `${a.handle.toUpperCase()}` } }).catch(() => {});
    const bCode = await getOrCreateReferralCode(b.userId, prisma);
    expect(bCode).not.toBe(code);
  });

  it('signup attach: first writer wins, no self-referrals, unknown codes no-op', async () => {
    const referrer = await makeUser('buyer');
    const other = await makeUser('buyer');
    const code = await getOrCreateReferralCode(referrer.userId, prisma);
    const otherCode = await getOrCreateReferralCode(other.userId, prisma);
    const newbie = await makeUser('buyer');

    expect(await applyReferralAtSignup(newbie.userId, 'no-such-code', prisma)).toBe(false);
    expect(await applyReferralAtSignup(referrer.userId, code, prisma)).toBe(false); // self
    expect(await applyReferralAtSignup(newbie.userId, `  ${code.toUpperCase()}  `, prisma)).toBe(true);
    expect(await applyReferralAtSignup(newbie.userId, otherCode, prisma)).toBe(false); // already set

    const row = await prisma.user.findUniqueOrThrow({ where: { id: newbie.userId } });
    expect(row.referredById).toBe(referrer.userId);
  });
});

describe('referral qualification', () => {
  it('first purchase pays both sides exactly once and unlocks the mission', async () => {
    const clock = new ManualClock(T0);
    const referrer = await makeUser('buyer');
    const code = await getOrCreateReferralCode(referrer.userId, prisma);

    const seller = await makeUser('buyer');
    await applyAsSeller(seller.userId, prisma);
    const l1 = await createMarketListing(
      seller.userId,
      { title: 'Slab One', photos: [PHOTO], saleMode: 'fixed', price: usdc('20'), shipPrices: { US: usdc('5') } },
      clock,
      prisma,
    );
    const l2 = await createMarketListing(
      seller.userId,
      { title: 'Slab Two', photos: [PHOTO], saleMode: 'fixed', price: usdc('20'), shipPrices: { US: usdc('5') } },
      clock,
      prisma,
    );

    const buyer = await makeFundedUser('100');
    await prisma.user.update({ where: { id: buyer.userId }, data: { shippingAddress: US_ADDR as object } });
    expect(await applyReferralAtSignup(buyer.userId, code, prisma)).toBe(true);

    const before = await pointsOf(referrer.userId);
    await buyMarketItem(buyer.userId, l1.listingId, { directPayout: false, escrow }, clock, prisma);

    expect(await pointsOf(referrer.userId)).toBe(before + REFERRER_POINTS);
    const q = await prisma.user.findUniqueOrThrow({ where: { id: buyer.userId } });
    expect(q.referralQualifiedAt).not.toBeNull();
    // Buyer got the purchase points AND the referee bonus.
    const refereeEvents = await prisma.pointsEvent.findMany({ where: { userId: buyer.userId, kind: 'referred' } });
    expect(refereeEvents).toHaveLength(1);
    expect(refereeEvents[0]!.points).toBe(REFEREE_POINTS);

    // A second purchase pays no second referral.
    await buyMarketItem(buyer.userId, l2.listingId, { directPayout: false, escrow }, clock, prisma);
    expect(await pointsOf(referrer.userId)).toBe(before + REFERRER_POINTS);

    // Mission "refer_friend" is now claimable for the referrer.
    const summary = await getPointsSummary(referrer.userId, prisma);
    const mission = summary.missions.find((m) => m.id === 'refer_friend')!;
    expect(mission.status).toBe('claimable');
    expect(mission.comingSoon).toBe(false);
  });

  it('qualify is a no-op without a referrer, and exactly-once under direct calls', async () => {
    const nobody = await makeFundedUser('50');
    expect(await qualifyReferral(nobody.userId, prisma)).toBe(false);

    const referrer = await makeUser('buyer');
    const code = await getOrCreateReferralCode(referrer.userId, prisma);
    const friend = await makeFundedUser('50');
    await applyReferralAtSignup(friend.userId, code, prisma);
    expect(await qualifyReferral(friend.userId, prisma)).toBe(true);
    expect(await qualifyReferral(friend.userId, prisma)).toBe(false);
    expect(await pointsOf(referrer.userId)).toBe(REFERRER_POINTS);
  });

  it('info + leaderboard count only qualified referrals', async () => {
    const alpha = await makeUser('buyer');
    const beta = await makeUser('buyer');
    const alphaCode = await getOrCreateReferralCode(alpha.userId, prisma);
    const betaCode = await getOrCreateReferralCode(beta.userId, prisma);

    // alpha refers 3 (2 qualify), beta refers 1 (1 qualifies).
    for (let i = 0; i < 3; i += 1) {
      const u = await makeFundedUser('50');
      await applyReferralAtSignup(u.userId, alphaCode, prisma);
      if (i < 2) await qualifyReferral(u.userId, prisma);
    }
    const bu = await makeFundedUser('50');
    await applyReferralAtSignup(bu.userId, betaCode, prisma);
    await qualifyReferral(bu.userId, prisma);

    const info = await getReferralInfo(alpha.userId, prisma);
    expect(info.referred).toBe(3);
    expect(info.qualified).toBe(2);
    expect(BigInt(info.pointsEarned)).toBe(2n * REFERRER_POINTS);

    const leaders = await referralLeaders(10, prisma);
    expect(leaders[0]!.userId).toBe(alpha.userId);
    expect(leaders[0]!.qualified).toBe(2);
    expect(leaders[1]!.userId).toBe(beta.userId);
    expect(leaders[1]!.qualified).toBe(1);
  });
});
