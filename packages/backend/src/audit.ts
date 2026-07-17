/**
 * Wallet ↔ ledger reconciliation — the pre-flip and ongoing safety check for
 * escrow mode. Each segregated wallet's on-chain USDC must equal its ledger
 * account; treasury holds every user's pooled balance. Any mismatch not explained
 * by in-flight ChainTransfer legs means the physical wallets and the ledger have
 * diverged — investigate before flipping BIDIT_PAYOUT_MODE to escrow.
 *
 *   escrow  wallet  ==  ESCROW ledger account   (funds held per order)
 *   buyback wallet  ==  PLATFORM ledger account (4% buyback pool)
 *   fee     wallet  ==  FEE ledger account      (1% fee + shipping)
 *   treasury wallet ==  Σ USER account balances (everyone's pooled money)
 */
import { SYSTEM_ACCOUNT_IDS, AccountKind } from '@bidit/shared';
import { prisma as defaultPrisma } from './db.js';
import type { PrismaClient } from './db.js';
import type { ChainClient, WalletName } from './chain/index.js';
import { getSettledBalance } from './ledger.js';

export interface WalletReconRow {
  wallet: WalletName;
  chain: bigint; // on-chain USDC micro-units
  ledger: bigint; // the ledger account this wallet backs
  diff: bigint; // chain − ledger (0 = reconciled)
}
export interface WalletRecon {
  rows: WalletReconRow[];
  pendingLegs: number; // in-flight ChainTransfer outbox legs (explain small diffs)
  reconciled: boolean; // every diff is 0
}

export async function reconcileWallets(
  chain: ChainClient,
  prisma: PrismaClient = defaultPrisma,
): Promise<WalletRecon> {
  const [escrowLedger, buybackLedger, feeLedger, userAccounts] = await Promise.all([
    getSettledBalance(SYSTEM_ACCOUNT_IDS.ESCROW, prisma),
    getSettledBalance(SYSTEM_ACCOUNT_IDS.PLATFORM, prisma),
    getSettledBalance(SYSTEM_ACCOUNT_IDS.FEE, prisma),
    prisma.account.findMany({ where: { kind: AccountKind.USER }, select: { id: true } }),
  ]);
  let userTotal = 0n;
  for (const a of userAccounts) userTotal += await getSettledBalance(a.id, prisma);

  const [escrowChain, buybackChain, feeChain, treasuryChain] = await Promise.all([
    chain.balance('escrow'),
    chain.balance('buyback'),
    chain.balance('fee'),
    chain.balance('treasury'),
  ]);

  const mk = (wallet: WalletName, chainBal: bigint, ledger: bigint): WalletReconRow => ({
    wallet,
    chain: chainBal,
    ledger,
    diff: chainBal - ledger,
  });
  const rows: WalletReconRow[] = [
    mk('escrow', escrowChain, escrowLedger),
    mk('buyback', buybackChain, buybackLedger),
    mk('fee', feeChain, feeLedger),
    mk('treasury', treasuryChain, userTotal),
  ];
  const pendingLegs = await prisma.chainTransfer.count({ where: { status: { in: ['PENDING', 'SUBMITTED'] } } });
  return { rows, pendingLegs, reconciled: rows.every((r) => r.diff === 0n) };
}
