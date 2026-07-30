import { describe, it, expect, beforeEach } from 'vitest';
import { prisma } from '../src/db.js';
import { MockChain } from '../src/chain/mock.js';
import { requestWithdrawal, withdrawnLast24h, dailyWithdrawCapMicros, WithdrawalError } from '../src/withdrawals.js';
import { ensureDepositAddress } from '../src/deposits.js';
import { getSettledBalance } from '../src/ledger.js';
import { usdc } from '@bidit/shared';
import { resetDb, makeFundedUser } from './setup.js';

const ADDR = 'SomeExternalWallet';

beforeEach(async () => {
  await resetDb();
  delete process.env.BIDIT_WITHDRAW_DAILY_CAP_USD;
});

describe('withdrawal daily cap + address validation', () => {
  it('rejects an invalid destination address before any money moves', async () => {
    const u = await makeFundedUser('100');
    const chain = new MockChain();
    await expect(requestWithdrawal(u.userId, '', usdc('10'), chain, prisma)).rejects.toThrow(WithdrawalError);
    expect(await getSettledBalance(u.accountId, prisma)).toBe(usdc('100')); // untouched
    expect(await prisma.withdrawal.count({ where: { userId: u.userId } })).toBe(0); // nothing recorded
  });

  it('rejects a withdrawal into an operator wallet or a deposit address (M1)', async () => {
    const u = await makeFundedUser('100');
    const chain = new MockChain();
    // Each operator wallet: an on-chain self-transfer that still debits the user.
    for (const w of ['treasury', 'escrow', 'buyback', 'fee'] as const) {
      await expect(requestWithdrawal(u.userId, chain.walletAddress(w), usdc('10'), chain, prisma))
        .rejects.toThrow(/valid withdrawal destination/);
    }
    // A user deposit address is internal too: it would just round-trip via the sweep.
    const dep = await ensureDepositAddress(u.userId, chain, prisma);
    await expect(requestWithdrawal(u.userId, dep, usdc('10'), chain, prisma))
      .rejects.toThrow(/valid withdrawal destination/);
    // Nothing moved, nothing recorded.
    expect(await getSettledBalance(u.accountId, prisma)).toBe(usdc('100'));
    expect(await prisma.withdrawal.count({ where: { userId: u.userId } })).toBe(0);
  });

  it('allows withdrawals up to $1,000/day and blocks the one that exceeds it', async () => {
    const u = await makeFundedUser('5000');
    const chain = new MockChain();
    await requestWithdrawal(u.userId, ADDR, usdc('600'), chain, prisma);
    await requestWithdrawal(u.userId, ADDR, usdc('400'), chain, prisma); // exactly $1,000
    expect(await withdrawnLast24h(u.userId, prisma)).toBe(usdc('1000'));
    // Above the minimum withdrawal, so this is the value cap talking, not the floor.
    await expect(requestWithdrawal(u.userId, ADDR, usdc('5'), chain, prisma)).rejects.toThrow(/1,000 per day/);
    // The blocked request neither moved money nor was recorded.
    expect(await withdrawnLast24h(u.userId, prisma)).toBe(usdc('1000'));
  });

  it('holds the daily cap under CONCURRENT withdrawals (M4: atomic)', async () => {
    const u = await makeFundedUser('5000'); // funds well over the cap, so only the cap can block
    const chain = new MockChain();
    // Fire 15 concurrent $100 withdrawals against the $1,000/day cap. Without the
    // atomic guard they'd all read used=0 and pass; with it, at most 10 succeed.
    const results = await Promise.allSettled(
      Array.from({ length: 15 }, () => requestWithdrawal(u.userId, ADDR, usdc('100'), chain, prisma)),
    );
    const ok = results.filter((r) => r.status === 'fulfilled').length;
    expect(ok).toBe(10);
    expect(await withdrawnLast24h(u.userId, prisma)).toBe(usdc('1000')); // never exceeds the cap
  });

  it('a failed withdrawal does not consume the daily cap', async () => {
    const u = await makeFundedUser('100');
    const chain = new MockChain();
    await requestWithdrawal(u.userId, ADDR, usdc('50'), chain, prisma); // CONFIRMED
    await expect(requestWithdrawal(u.userId, ADDR, usdc('200'), chain, prisma)).rejects.toThrow(); // insufficient → FAILED
    expect(await withdrawnLast24h(u.userId, prisma)).toBe(usdc('50')); // FAILED excluded
  });

  it('honours the BIDIT_WITHDRAW_DAILY_CAP_USD override', async () => {
    process.env.BIDIT_WITHDRAW_DAILY_CAP_USD = '50';
    expect(dailyWithdrawCapMicros()).toBe(usdc('50'));
    const u = await makeFundedUser('500');
    const chain = new MockChain();
    await expect(requestWithdrawal(u.userId, ADDR, usdc('60'), chain, prisma)).rejects.toThrow(/50 per day/);
    await requestWithdrawal(u.userId, ADDR, usdc('50'), chain, prisma); // exactly at the cap is allowed
    expect(await withdrawnLast24h(u.userId, prisma)).toBe(usdc('50'));
  });

  it('defaults to a $1,000 cap when the override is unset', () => {
    expect(dailyWithdrawCapMicros()).toBe(usdc('1000'));
  });
});

/**
 * The rent-drain (C1): paying an address that has never held USDC makes TREASURY
 * fund that address's token account (~0.00204 SOL, well over $0.30). With no
 * floor on the amount and a cap that counted dollars rather than requests, an
 * attacker sent 1 micro-USDC to endless fresh keypairs, closed each account, and
 * kept the rent. Every request was profitable, and an empty treasury stops
 * withdrawals, deposit sweeps and escrow legs together.
 */
describe('treasury SOL drain via destination token-account rent (C1)', () => {
  beforeEach(() => {
    delete process.env.BIDIT_MIN_WITHDRAW_USD;
    delete process.env.BIDIT_WITHDRAW_DAILY_COUNT;
    delete process.env.BIDIT_NEW_DEST_DAILY_BUDGET;
  });

  it('refuses dust withdrawals, which is what made rent-farming free', async () => {
    const u = await makeFundedUser('100');
    const chain = new MockChain();
    // 1 micro-USDC: the exact amount the attack used.
    await expect(requestWithdrawal(u.userId, ADDR, 1n, chain, prisma)).rejects.toThrow(/smallest withdrawal/);
    await expect(requestWithdrawal(u.userId, ADDR, usdc('0.01'), chain, prisma)).rejects.toThrow(/smallest withdrawal/);
    expect(await getSettledBalance(u.accountId, prisma)).toBe(usdc('100'));
    expect(await prisma.withdrawal.count()).toBe(0);
  });

  it('caps how many withdrawals one user can start per day, not just their value', async () => {
    process.env.BIDIT_WITHDRAW_DAILY_COUNT = '3';
    const u = await makeFundedUser('1000');
    const chain = new MockChain();
    for (let i = 0; i < 3; i++) {
      await requestWithdrawal(u.userId, `${ADDR}${i}`, usdc('5'), chain, prisma);
    }
    // Well under the $1,000 value cap, but out of requests.
    await expect(requestWithdrawal(u.userId, `${ADDR}x`, usdc('5'), chain, prisma))
      .rejects.toThrow(/withdrawals per day/);
    expect(await prisma.withdrawal.count({ where: { userId: u.userId } })).toBe(3);
  });

  it('fails closed once the platform-wide new-destination budget is spent', async () => {
    process.env.BIDIT_NEW_DEST_DAILY_BUDGET = '2';
    const chain = new MockChain();
    chain.setDestinationsNeedFunding(true); // every destination costs us rent

    // Separate users, because the budget has to bound the whole platform: free
    // accounts are exactly how the attacker got around per-user limits.
    const a = await makeFundedUser('500');
    const b = await makeFundedUser('500');
    const c = await makeFundedUser('500');
    await requestWithdrawal(a.userId, `${ADDR}A`, usdc('5'), chain, prisma);
    await requestWithdrawal(b.userId, `${ADDR}B`, usdc('5'), chain, prisma);
    await expect(requestWithdrawal(c.userId, `${ADDR}C`, usdc('5'), chain, prisma))
      .rejects.toThrow(/never held USDC/);
    expect(await getSettledBalance(c.accountId, prisma)).toBe(usdc('500')); // untouched

    // A destination that already holds USDC costs treasury nothing, so it is
    // still allowed with the budget exhausted.
    chain.markDestinationFunded(`${ADDR}FUNDED`);
    const ok = await requestWithdrawal(c.userId, `${ADDR}FUNDED`, usdc('5'), chain, prisma);
    expect(ok.fundedDestAccount).toBe(false);
    expect(['SUBMITTED', 'CONFIRMED']).toContain(ok.status);
  });

  it('records which withdrawals cost treasury rent, so the budget can be audited', async () => {
    const chain = new MockChain();
    chain.setDestinationsNeedFunding(true);
    const u = await makeFundedUser('100');
    const w = await requestWithdrawal(u.userId, `${ADDR}NEW`, usdc('10'), chain, prisma);
    expect(w.fundedDestAccount).toBe(true);
  });

  it('treats a chain lookup failure as needing funding, so a blip cannot leak rent', async () => {
    const chain = new MockChain();
    chain.destinationNeedsFunding = () => Promise.reject(new Error('rpc down'));
    process.env.BIDIT_NEW_DEST_DAILY_BUDGET = '0';
    const u = await makeFundedUser('100');
    await expect(requestWithdrawal(u.userId, `${ADDR}Z`, usdc('10'), chain, prisma))
      .rejects.toThrow(/never held USDC/);
  });
});
