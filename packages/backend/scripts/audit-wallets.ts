/**
 * Wallet ↔ ledger reconciliation CLI. Reads DATABASE_URL + SOLANA_RPC (+ wallet
 * secrets) from the environment, so run it against PRODUCTION (or on the Render
 * shell) to verify every wallet matches its ledger account before flipping
 * BIDIT_PAYOUT_MODE to escrow — and as an ongoing health check afterward.
 *
 *   DATABASE_URL=<prod> SOLANA_RPC=<rpc> ESCROW_SECRET=… BUYBACK_SECRET=… FEE_SECRET=… \
 *   npm -w @bidit/backend run audit:wallets
 */
import { prisma } from '../src/db.js';
import { getChainClient } from '../src/chain/index.js';
import { reconcileWallets } from '../src/audit.js';
import { formatUsdc } from '@bidit/shared';

async function main() {
  const chain = await getChainClient();
  const recon = await reconcileWallets(chain, prisma);
  const fmt = (m: bigint) => `$${formatUsdc(m)}`;

  console.log(`\nWallet ↔ ledger reconciliation (cluster: ${chain.cluster})\n`);
  console.log(`${'wallet'.padEnd(10)} ${'on-chain'.padEnd(17)} ${'ledger'.padEnd(17)} diff`);
  console.log('-'.repeat(55));
  for (const r of recon.rows) {
    console.log(`${r.wallet.padEnd(10)} ${fmt(r.chain).padEnd(17)} ${fmt(r.ledger).padEnd(17)} ${r.diff === 0n ? 'ok' : fmt(r.diff)}`);
  }
  console.log(`\npending on-chain legs (settler outbox): ${recon.pendingLegs}`);
  if (recon.reconciled) {
    console.log('\n✅ Reconciled — every wallet matches its ledger account.\n');
  } else if (recon.pendingLegs > 0) {
    console.log(`\n⏳ Not reconciled yet, but ${recon.pendingLegs} leg(s) are still settling — re-run once the settler drains.\n`);
  } else {
    console.log('\n⚠️  MISMATCH with no pending legs — investigate before flipping to escrow.\n');
  }
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});
