import { describe, it, expect, beforeEach } from 'vitest';
import { prisma } from '../src/db.js';
import { MockChain } from '../src/chain/mock.js';
import { requestWithdrawal, withdrawnLast24h, WithdrawalReconciler } from '../src/withdrawals.js';
import { getSettledBalance, getSystemTotal } from '../src/ledger.js';
import { usdc } from '@bidit/shared';
import { resetDb, makeFundedUser } from './setup.js';

const ADDR = 'ExternalUserWallet';

const reverseEntry = (withdrawalId: string) =>
  prisma.ledgerEntry.findUnique({ where: { idempotencyKey: `withdraw-reverse:${withdrawalId}` } });

beforeEach(async () => {
  await resetDb();
  delete process.env.BIDIT_WITHDRAW_DAILY_CAP_USD;
});

describe('withdrawal settlement state machine', () => {
  it('happy path: confirms, debits exactly once, moves the funds on-chain', async () => {
    const u = await makeFundedUser('100');
    const chain = new MockChain();

    const w = await requestWithdrawal(u.userId, ADDR, usdc('30'), chain, prisma);

    expect(w.status).toBe('CONFIRMED');
    expect(w.txSig).toBeTruthy();
    expect(w.reversedAt).toBeNull();
    expect(await getSettledBalance(u.accountId, prisma)).toBe(usdc('70'));
    expect(await chain.balance(ADDR)).toBe(usdc('30'));
    expect(await reverseEntry(w.id)).toBeNull(); // never reversed
    expect(await getSystemTotal(prisma)).toBe(0n);
  });

  it('an ambiguous broadcast is NEVER reversed, and confirming later does not double-spend', async () => {
    // This is the exact scenario the old code got wrong: the send times out (fate
    // unknown) but the transfer actually lands on-chain. Reversing on the timeout
    // would give the user their balance back AND the on-chain USDC.
    const u = await makeFundedUser('100');
    const chain = new MockChain();
    chain.ambiguousNextSend();

    const w = await requestWithdrawal(u.userId, ADDR, usdc('40'), chain, prisma);

    // In flight: broadcast, debit applied, NOT reversed, funds not yet landed.
    expect(w.status).toBe('SUBMITTED');
    expect(w.txSig).toBeTruthy();
    expect(w.reversedAt).toBeNull();
    expect(await getSettledBalance(u.accountId, prisma)).toBe(usdc('60')); // debited, held out
    expect(await chain.balance(ADDR)).toBe(0n); // hasn't landed yet
    expect(await reverseEntry(w.id)).toBeNull(); // the critical assertion: no optimistic reversal

    // The transfer actually lands. Reconcile resolves it to CONFIRMED.
    chain.resolveTransfer(w.txSig!, 'confirmed');
    expect(await new WithdrawalReconciler(chain, prisma).tick()).toBe(1);

    const after = await prisma.withdrawal.findUniqueOrThrow({ where: { id: w.id } });
    expect(after.status).toBe('CONFIRMED');
    expect(after.reversedAt).toBeNull();
    // Debited exactly once, never credited back → the treasury and the ledger agree.
    expect(await getSettledBalance(u.accountId, prisma)).toBe(usdc('60'));
    expect(await chain.balance(ADDR)).toBe(usdc('40'));
    expect(await reverseEntry(w.id)).toBeNull();
    expect(await getSystemTotal(prisma)).toBe(0n);
  });

  it('a broadcast the chain later proves dead is reversed exactly once', async () => {
    const u = await makeFundedUser('100');
    const chain = new MockChain();
    chain.ambiguousNextSend();

    const w = await requestWithdrawal(u.userId, ADDR, usdc('40'), chain, prisma);
    expect(w.status).toBe('SUBMITTED');
    expect(await getSettledBalance(u.accountId, prisma)).toBe(usdc('60'));

    // Chain confirms it never landed (expired / erred) → reconcile reverses the debit.
    chain.resolveTransfer(w.txSig!, 'failed');
    expect(await new WithdrawalReconciler(chain, prisma).tick()).toBe(1);

    const after = await prisma.withdrawal.findUniqueOrThrow({ where: { id: w.id } });
    expect(after.status).toBe('FAILED');
    expect(after.reversedAt).not.toBeNull();
    expect(await getSettledBalance(u.accountId, prisma)).toBe(usdc('100')); // funds returned
    expect(await chain.balance(ADDR)).toBe(0n); // nothing left the treasury

    // Re-running reconcile must not reverse a second time.
    expect(await new WithdrawalReconciler(chain, prisma).tick()).toBe(0);
    expect(await getSettledBalance(u.accountId, prisma)).toBe(usdc('100'));
    expect(await prisma.ledgerEntry.count({ where: { idempotencyKey: `withdraw-reverse:${w.id}` } })).toBe(1);
    expect(await getSystemTotal(prisma)).toBe(0n);
  });

  it('a pre-broadcast send failure reverses the debit and frees the cap', async () => {
    const u = await makeFundedUser('100');
    const chain = new MockChain();
    chain.failNextSend(); // throws before broadcasting → funds definitively never moved

    const w = await requestWithdrawal(u.userId, ADDR, usdc('40'), chain, prisma);

    expect(w.status).toBe('FAILED');
    expect(w.reversedAt).not.toBeNull();
    expect(await getSettledBalance(u.accountId, prisma)).toBe(usdc('100')); // restored
    expect(await chain.balance(ADDR)).toBe(0n);
    expect(await withdrawnLast24h(u.userId, prisma)).toBe(0n); // FAILED excluded from the cap
    expect(await getSystemTotal(prisma)).toBe(0n);
  });

  it('an in-flight (SUBMITTED) withdrawal counts against the daily cap until proven dead', async () => {
    process.env.BIDIT_WITHDRAW_DAILY_CAP_USD = '50';
    const u = await makeFundedUser('1000');
    const chain = new MockChain();
    chain.ambiguousNextSend();

    const w = await requestWithdrawal(u.userId, ADDR, usdc('40'), chain, prisma);
    expect(w.status).toBe('SUBMITTED');
    expect(await withdrawnLast24h(u.userId, prisma)).toBe(usdc('40')); // in-flight counts

    // A second request that would exceed the cap is blocked while the first is out.
    await expect(requestWithdrawal(u.userId, ADDR, usdc('20'), chain, prisma)).rejects.toThrow(/50 per day/);

    // Once the first is proven dead and reversed, the cap frees back up.
    chain.resolveTransfer(w.txSig!, 'failed');
    await new WithdrawalReconciler(chain, prisma).tick();
    expect(await withdrawnLast24h(u.userId, prisma)).toBe(0n);
  });

  it('reconcile settles a withdrawal left SUBMITTED by a prior crash/restart', async () => {
    const u = await makeFundedUser('100');
    const chain = new MockChain();
    chain.ambiguousNextSend();
    const w = await requestWithdrawal(u.userId, ADDR, usdc('25'), chain, prisma);
    expect(w.status).toBe('SUBMITTED'); // process "restarts" here, row left in flight

    // A fresh reconciler (as on startup) finds and finalizes it.
    chain.resolveTransfer(w.txSig!, 'confirmed');
    expect(await new WithdrawalReconciler(chain, prisma).reconcile()).toBe(1);
    expect((await prisma.withdrawal.findUniqueOrThrow({ where: { id: w.id } })).status).toBe('CONFIRMED');
    expect(await getSettledBalance(u.accountId, prisma)).toBe(usdc('75'));
    expect(await getSystemTotal(prisma)).toBe(0n);
  });
});
