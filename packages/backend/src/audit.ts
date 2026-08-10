/**
 * Wallet ↔ ledger reconciliation: the pre-flip and ongoing safety check for
 * escrow mode. Each segregated wallet's on-chain USDC must equal its ledger
 * account; treasury holds every user's pooled balance. Any mismatch not explained
 * by in-flight ChainTransfer legs means the physical wallets and the ledger have
 * diverged: investigate before flipping BIDIT_PAYOUT_MODE to escrow.
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
import { getSolUsdPrice, lamportsToUsdcMicros, type SolPrice } from './prices.js';

export interface WalletReconRow {
  wallet: WalletName;
  chain: bigint; // on-chain USDC micro-units (treasury: USDC + unswapped SOL valued at spot)
  ledger: bigint; // the ledger account this wallet backs
  diff: bigint; // chain − ledger (0 = reconciled)
}
export interface WalletRecon {
  rows: WalletReconRow[];
  pendingLegs: number; // in-flight ChainTransfer outbox legs (explain small diffs)
  reconciled: boolean; // every diff is 0 (treasury: chain value ≥ ledger, i.e. never short)
  /** Native SOL still sitting in treasury (lamports) awaiting auto-swap, and its
   *  spot USD value folded into the treasury chain figure. Null price ⇒ couldn't
   *  value it this pass (oracle down); the SOL is then excluded and flagged. */
  treasurySolLamports: bigint;
  treasurySolUsdMicros: bigint;
  solPriced: boolean;
}

export async function reconcileWallets(
  chain: ChainClient,
  prisma: PrismaClient = defaultPrisma,
  priceFn: () => Promise<SolPrice> = () => getSolUsdPrice(),
): Promise<WalletRecon> {
  const [escrowLedger, buybackLedger, feeLedger, userAccounts] = await Promise.all([
    getSettledBalance(SYSTEM_ACCOUNT_IDS.ESCROW, prisma),
    getSettledBalance(SYSTEM_ACCOUNT_IDS.PLATFORM, prisma),
    getSettledBalance(SYSTEM_ACCOUNT_IDS.FEE, prisma),
    prisma.account.findMany({ where: { kind: AccountKind.USER }, select: { id: true } }),
  ]);
  let userTotal = 0n;
  for (const a of userAccounts) userTotal += await getSettledBalance(a.id, prisma);

  const [escrowChain, buybackChain, feeChain, treasuryChain, treasurySolLamports] = await Promise.all([
    chain.balance('escrow'),
    chain.balance('buyback'),
    chain.balance('fee'),
    chain.balance('treasury'),
    chain.solBalanceLamports('treasury'),
  ]);

  // Treasury holds USDC PLUS any SOL that's been swept but not yet auto-swapped.
  // That SOL still backs user balances, so value it at spot and fold it into the
  // treasury figure. If the oracle is unavailable we can't value it: exclude it
  // and flag solPriced=false so a low treasury diff isn't mistaken for a loss.
  let treasurySolUsdMicros = 0n;
  let solPriced = true;
  if (treasurySolLamports > 0n) {
    try {
      const price = await priceFn();
      // No spread here: this is a mark-to-market valuation, not a user credit.
      treasurySolUsdMicros = lamportsToUsdcMicros(treasurySolLamports, price.usdMicro, 0n);
    } catch {
      solPriced = false;
    }
  }
  const treasuryValue = treasuryChain + treasurySolUsdMicros;

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
    mk('treasury', treasuryValue, userTotal),
  ];
  const pendingLegs = await prisma.chainTransfer.count({ where: { status: { in: ['PENDING', 'SUBMITTED'] } } });
  // Segregated wallets must match exactly; treasury must merely be NOT SHORT
  // (chain value ≥ liabilities) — the deposit spread makes it run slightly rich,
  // which is safe. A negative treasury diff means real money is missing.
  const segregatedOk = rows.slice(0, 3).every((r) => r.diff === 0n);
  const treasuryOk = solPriced && rows[3]!.diff >= 0n;
  return {
    rows,
    pendingLegs,
    reconciled: segregatedOk && treasuryOk,
    treasurySolLamports,
    treasurySolUsdMicros,
    solPriced,
  };
}
