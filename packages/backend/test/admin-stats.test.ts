import { describe, it, expect, beforeEach } from 'vitest';
import { prisma } from '../src/db.js';
import { adminStats } from '../src/admin.js';
import { deposit } from '../src/ledger.js';
import { applyAsSeller } from '../src/authz.js';
import { usdc } from '@bidit/shared';
import { resetDb, makeUser } from './setup.js';

const HOUR = 3_600_000;
const DAY = 86_400_000;

const backdate = (userId: string, createdAt: Date) =>
  prisma.user.update({ where: { id: userId }, data: { createdAt } });

describe('adminStats', () => {
  beforeEach(async () => { await resetDb(); });

  it('refuses non-admins', async () => {
    const u = await makeUser('buyer');
    await expect(adminStats(u.userId, prisma)).rejects.toThrow();
  });

  it('counts signups into the right windows and zero-filled series', async () => {
    const now = Date.now();
    const admin = await makeUser('admin');
    const fresh = await makeUser('buyer');
    const twoHoursAgo = await makeUser('buyer');
    await backdate(twoHoursAgo.userId, new Date(now - 2 * HOUR));
    const threeDaysAgo = await makeUser('buyer');
    await backdate(threeDaysAgo.userId, new Date(now - 3 * DAY));
    await applyAsSeller(fresh.userId, prisma);

    const s = await adminStats(admin.userId, prisma, now);
    expect(s.users.total).toBe(4);
    expect(s.users.lastHour).toBe(2); // admin + fresh
    expect(s.users.lastDay).toBe(3); // + the 2h-ago user
    expect(s.users.last7d).toBe(4);
    expect(s.users.sellers).toBe(1);

    // Series shape: fixed length, zero-filled, and the counts add up.
    expect(s.users.hourly).toHaveLength(24);
    expect(s.users.daily).toHaveLength(14);
    expect(s.users.hourly.reduce((n, p) => n + p.n, 0)).toBe(3);
    expect(s.users.daily.reduce((n, p) => n + p.n, 0)).toBe(4);
    // Buckets ascend in fixed steps ending at the current hour.
    expect(s.users.hourly[23]!.t - s.users.hourly[0]!.t).toBe(23 * HOUR);
  });

  it('sums money: gmv excludes refunds, fees only on released, buybacks executed-only', async () => {
    const admin = await makeUser('admin');
    const buyer = await makeUser('buyer');
    const seller = await makeUser('seller');

    await prisma.order.createMany({
      data: [
        { buyerId: buyer.userId, sellerId: seller.userId, amount: usdc('20'), platformFee: usdc('1'), sellerProceeds: usdc('19'), status: 'RELEASED' },
        { buyerId: buyer.userId, sellerId: seller.userId, amount: usdc('10'), platformFee: usdc('0.5'), sellerProceeds: usdc('9.5'), status: 'LOCKED' },
        { buyerId: buyer.userId, sellerId: seller.userId, amount: usdc('5'), platformFee: usdc('0.25'), sellerProceeds: usdc('4.75'), status: 'REFUNDED' },
      ],
    });
    await prisma.buyback.createMany({
      data: [
        { amount: usdc('4'), status: 'EXECUTED' },
        { amount: usdc('99'), status: 'FAILED' }, // never counted
      ],
    });
    await deposit({ accountId: buyer.accountId, amount: usdc('50') }, prisma);

    const s = await adminStats(admin.userId, prisma);
    expect(s.money.gmvUsd).toBe('30');
    expect(s.money.orders).toBe(2);
    expect(s.money.feesUsd).toBe('1');
    expect(s.money.releasedOrders).toBe(1);
    expect(s.money.refundedUsd).toBe('5');
    expect(s.money.refundedOrders).toBe(1);
    expect(s.money.buybackUsd).toBe('4');
    expect(s.money.buybacks).toBe(1);
    expect(s.money.depositedUsd).toBe('50');
    expect(s.money.withdrawnUsd).toBe('0');
  });
});
