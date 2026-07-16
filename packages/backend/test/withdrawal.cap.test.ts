import { describe, it, expect, beforeEach } from 'vitest';
import { prisma } from '../src/db.js';
import { MockChain } from '../src/chain/mock.js';
import { requestWithdrawal, withdrawnLast24h, dailyWithdrawCapMicros, WithdrawalError } from '../src/withdrawals.js';
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

  it('allows withdrawals up to $1,000/day and blocks the one that exceeds it', async () => {
    const u = await makeFundedUser('5000');
    const chain = new MockChain();
    await requestWithdrawal(u.userId, ADDR, usdc('600'), chain, prisma);
    await requestWithdrawal(u.userId, ADDR, usdc('400'), chain, prisma); // exactly $1,000
    expect(await withdrawnLast24h(u.userId, prisma)).toBe(usdc('1000'));
    await expect(requestWithdrawal(u.userId, ADDR, usdc('1'), chain, prisma)).rejects.toThrow(/1,000 per day/);
    // The blocked request neither moved money nor was recorded.
    expect(await withdrawnLast24h(u.userId, prisma)).toBe(usdc('1000'));
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
