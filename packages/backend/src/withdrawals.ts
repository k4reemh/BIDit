/**
 * Withdrawal rail: debit the ledger (which checks available = settled − holds, so
 * locked bid funds can't be withdrawn), then send USDC on-chain from treasury. If
 * the send fails, the debit is reversed and the withdrawal marked FAILED.
 */
import { LedgerType, LedgerRefType, type Micros } from '@bidit/shared';
import type { Withdrawal } from '@prisma/client';
import { prisma as defaultPrisma } from './db.js';
import type { PrismaClient } from './db.js';
import { debit, credit, getOrCreateUserAccount } from './ledger.js';
import type { ChainClient } from './chain/index.js';

export async function requestWithdrawal(
  userId: string,
  toAddress: string,
  amountMicros: Micros,
  chain: ChainClient,
  prisma: PrismaClient = defaultPrisma,
): Promise<Withdrawal> {
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
