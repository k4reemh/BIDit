/**
 * Withdrawal rail: validate the destination + enforce the beta daily cap, debit
 * the ledger (which checks available = settled − holds, so locked bid funds can't
 * be withdrawn), then send USDC on-chain from treasury. If the send fails, the
 * debit is reversed and the withdrawal marked FAILED.
 *
 * Beta safety: a temporary per-user rolling-24h cap (default $1,000, override with
 * BIDIT_WITHDRAW_DAILY_CAP_USD) bounds the blast radius of any exploit while the
 * on-chain settlement path is still being hardened.
 */
import { LedgerType, LedgerRefType, usdc, formatUsdc, type Micros } from '@bidit/shared';
import type { Withdrawal } from '@prisma/client';
import { prisma as defaultPrisma } from './db.js';
import type { PrismaClient } from './db.js';
import { debit, credit, getOrCreateUserAccount } from './ledger.js';
import type { ChainClient } from './chain/index.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** A user-facing withdrawal rejection (bad address, over the daily cap). */
export class WithdrawalError extends Error {
  readonly status = 400;
  constructor(message: string) {
    super(message);
    this.name = 'WithdrawalError';
  }
}

/** Temporary beta cap: max USDC a single user may withdraw per rolling 24h. */
export function dailyWithdrawCapMicros(): bigint {
  const raw = process.env.BIDIT_WITHDRAW_DAILY_CAP_USD;
  if (raw != null && raw.trim() !== '') {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return usdc(String(n));
  }
  return usdc('1000');
}

/** USDC a user has already committed to withdrawing in the last 24h (in-flight or
 *  confirmed — failed/reversed withdrawals don't count against the cap). */
export async function withdrawnLast24h(userId: string, prisma: PrismaClient = defaultPrisma): Promise<bigint> {
  const agg = await prisma.withdrawal.aggregate({
    where: { userId, createdAt: { gte: new Date(Date.now() - DAY_MS) }, status: { in: ['PENDING', 'SUBMITTED', 'CONFIRMED'] } },
    _sum: { amount: true },
  });
  return agg._sum.amount ?? 0n;
}

export async function requestWithdrawal(
  userId: string,
  toAddress: string,
  amountMicros: Micros,
  chain: ChainClient,
  prisma: PrismaClient = defaultPrisma,
): Promise<Withdrawal> {
  // 1. Destination must be a valid on-chain address — before any ledger movement.
  if (!chain.isValidAddress(toAddress)) {
    throw new WithdrawalError('That doesn’t look like a valid Solana address.');
  }

  // 2. Temporary beta daily cap. Checked before debiting so an over-cap request
  //    never moves money. (Not a hard concurrency guard — acceptable for beta,
  //    where the cap is a blast-radius limit, not a security boundary.)
  const cap = dailyWithdrawCapMicros();
  const used = await withdrawnLast24h(userId, prisma);
  if (used + amountMicros > cap) {
    const remaining = used >= cap ? 0n : cap - used;
    const money = (m: bigint) => Number(formatUsdc(m)).toLocaleString('en-US', { maximumFractionDigits: 2 });
    throw new WithdrawalError(
      `Beta withdrawals are limited to $${money(cap)} per day. You have $${money(remaining)} left in the next 24h.`,
    );
  }

  const accountId = await getOrCreateUserAccount(userId, prisma);
  const withdrawal = await prisma.withdrawal.create({
    data: { userId, toAddress, amount: amountMicros, status: 'PENDING' },
  });

  // Debit first (this enforces the no-overspend / holds-respected guarantee).
  // Throws InsufficientFundsError if available < amount — caller handles it.
  try {
    await debit(
      {
        accountId,
        amount: amountMicros,
        type: LedgerType.WITHDRAWAL,
        refType: LedgerRefType.WITHDRAWAL,
        refId: withdrawal.id,
        idempotencyKey: `withdraw:${withdrawal.id}`,
      },
      prisma,
    );
  } catch (err) {
    await prisma.withdrawal.update({ where: { id: withdrawal.id }, data: { status: 'FAILED' } });
    throw err;
  }

  // Then send on-chain. On failure, reverse the debit.
  try {
    const txSig = await chain.transfer('treasury', toAddress, amountMicros, `withdraw:${withdrawal.id}`);
    return prisma.withdrawal.update({
      where: { id: withdrawal.id },
      data: { status: 'CONFIRMED', txSig },
    });
  } catch (err) {
    await credit(
      {
        accountId,
        amount: amountMicros,
        type: LedgerType.REFUND,
        refType: LedgerRefType.ADJUSTMENT,
        refId: withdrawal.id,
        idempotencyKey: `withdraw-reverse:${withdrawal.id}`,
      },
      prisma,
    );
    return prisma.withdrawal.update({ where: { id: withdrawal.id }, data: { status: 'FAILED' } });
  }
}
