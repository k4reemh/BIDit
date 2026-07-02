import { describe, it, expect, beforeEach } from 'vitest';
import { prisma } from '../src/db.js';
import {
  deposit,
  withdraw,
  getAvailableBalance,
  getSettledBalance,
  getSystemTotal,
} from '../src/ledger.js';
import { InsufficientFundsError } from '../src/errors.js';
import { usdc, SYSTEM_ACCOUNT_IDS } from '@bidit/shared';
import { resetDb, makeUser } from './setup.js';

beforeEach(async () => {
  await resetDb();
});

describe('no double-spend under concurrency', () => {
  it('exactly floor(balance/amount) concurrent debits succeed', async () => {
    const buyer = await makeUser('buyer');
    await deposit({ accountId: buyer.accountId, amount: usdc('100') }, prisma);

    // 20 concurrent attempts to withdraw $50 from a $100 balance.
    const attempts = Array.from({ length: 20 }, () =>
      withdraw({ accountId: buyer.accountId, amount: usdc('50') }, prisma),
    );
    const results = await Promise.allSettled(attempts);

    const ok = results.filter((r) => r.status === 'fulfilled');
    const failed = results.filter((r) => r.status === 'rejected');
    expect(ok).toHaveLength(2);
    expect(failed).toHaveLength(18);
    for (const f of failed) {
      expect((f as PromiseRejectedResult).reason).toBeInstanceOf(InsufficientFundsError);
    }

    expect(await getAvailableBalance(buyer.accountId, prisma)).toBe(0n);
    expect(await getSystemTotal(prisma)).toBe(0n);
  });

  it('the last micro-unit cannot be spent twice', async () => {
    const buyer = await makeUser('buyer');
    await deposit({ accountId: buyer.accountId, amount: usdc('100') }, prisma);

    // 12 concurrent attempts to withdraw the WHOLE balance.
    const attempts = Array.from({ length: 12 }, () =>
      withdraw({ accountId: buyer.accountId, amount: usdc('100') }, prisma),
    );
    const results = await Promise.allSettled(attempts);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await getAvailableBalance(buyer.accountId, prisma)).toBe(0n);
    expect(await getSystemTotal(prisma)).toBe(0n);
  });

  it('concurrent deposits with the same idempotency key apply once', async () => {
    const buyer = await makeUser('buyer');
    const attempts = Array.from({ length: 10 }, () =>
      deposit(
        { accountId: buyer.accountId, amount: usdc('10'), idempotencyKey: 'dup-key' },
        prisma,
      ),
    );
    await Promise.allSettled(attempts);

    expect(await getSettledBalance(buyer.accountId, prisma)).toBe(usdc('10'));
    const count = await prisma.ledgerEntry.count({
      where: { accountId: buyer.accountId },
    });
    expect(count).toBe(1);
    expect(await getSettledBalance(SYSTEM_ACCOUNT_IDS.EXTERNAL, prisma)).toBe(usdc('-10'));
    expect(await getSystemTotal(prisma)).toBe(0n);
  });
});
