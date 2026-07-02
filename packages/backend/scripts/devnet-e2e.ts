/**
 * Devnet end-to-end: proves the real SolanaChain moves actual (test) USDC through
 * the whole BIDit money flow. Run with:  npm run devnet:e2e
 *
 * It loads packages/backend/.env.devnet for the Solana config (SOLANA_RPC,
 * USDC_MINT, *_SECRET keypairs, DEPOSIT_SEED) — those values stay on your machine.
 * The ledger runs on a throwaway local Postgres (test profile); the MONEY is real
 * devnet. Every on-chain step prints a Solana Explorer link.
 *
 * Flow: deposit -> bid -> win -> escrow lock -> ship -> deliver -> release
 *       (95% seller / 5% buyback) -> buyback reserved -> seller withdraws.
 */
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Keypair } from '@solana/web3.js';

const here = path.dirname(fileURLToPath(import.meta.url));

// Load .env.devnet WITHOUT overriding anything already set (with-db sets DATABASE_URL).
function loadEnvFile(file: string): void {
  if (!existsSync(file)) {
    console.error(`\nMissing ${file} — see docs/DEVNET.md to create it.\n`);
    process.exit(1);
  }
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || line.trim().startsWith('#')) continue;
    let val = m[2]!;
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!process.env[m[1]!]) process.env[m[1]!] = val;
  }
}
loadEnvFile(path.resolve(here, '../.env.devnet'));

// Imports that read env live after loadEnvFile.
const { prisma } = await import('../src/db.js');
const { ensureSystemAccounts } = await import('../src/bootstrap.js');
const { getChainClient } = await import('../src/chain/index.js');
const { ProgramEscrow } = await import('../src/escrow.js');
const { DepositWatcher, ensureDepositAddress } = await import('../src/deposits.js');
const { requestWithdrawal } = await import('../src/withdrawals.js');
const { BuybackWorker, MockSwapper } = await import('../src/buyback.js');
const { createListing } = await import('../src/listings.js');
const { startAuctionFromListing } = await import('../src/sellers.js');
const { placeBid, closeDueAuctions } = await import('../src/auction.js');
const { settleAuction, markShipped, markDelivered, processOrderTimers, DISPUTE_WINDOW_MS } =
  await import('../src/orders.js');
const { getSettledBalance, getBuybackPending, getOrCreateUserAccount } = await import('../src/ledger.js');
const { ManualClock } = await import('../src/clock.js');
const { usdc, formatUsdc } = await import('@bidit/shared');

const explorer = (sig: string) => `https://explorer.solana.com/tx/${sig}?cluster=devnet`;
const fmt = (m: bigint) => `$${formatUsdc(m)}`;

async function main() {
  const chain = await getChainClient();
  if (chain.cluster === 'mock') {
    console.error('\nSOLANA_RPC not set — getChainClient() returned MockChain. Set up .env.devnet first.\n');
    process.exit(1);
  }
  console.log(`\n== BIDit devnet e2e (cluster: ${chain.cluster}) ==`);
  console.log(`treasury ${chain.walletAddress('treasury')}`);
  console.log(`escrow   ${chain.walletAddress('escrow')}`);
  console.log(`buyback  ${chain.walletAddress('buyback')}\n`);

  await ensureSystemAccounts(prisma);
  const escrow = new ProgramEscrow(chain, prisma);
  const clock = new ManualClock(Date.now());
  const stamp = Date.now();

  // --- users -------------------------------------------------------------
  const buyer = await prisma.user.create({ data: { handle: `buyer_${stamp}`, role: 'buyer' } });
  const seller = await prisma.user.create({ data: { handle: `seller_${stamp}`, role: 'seller' } });
  await getOrCreateUserAccount(buyer.id, prisma);
  const sellerAcct = await getOrCreateUserAccount(seller.id, prisma);
  await prisma.sellerProfile.create({ data: { userId: seller.id, verified: true } });
  const buyerAcct = await getOrCreateUserAccount(buyer.id, prisma);

  // --- 1. deposit: send test USDC to the buyer's derived deposit address --
  const depositAddr = await ensureDepositAddress(buyer.id, chain, prisma);
  console.log(`1) buyer deposit address: ${depositAddr}`);
  console.log('   sending $100 test USDC from treasury -> deposit address (simulating a user deposit)...');
  const depSig = await chain.transfer('treasury', depositAddr, usdc('100'));
  console.log(`   on-chain: ${explorer(depSig)}`);

  console.log('   running deposit watcher (sweeps -> treasury, credits ledger)...');
  await new DepositWatcher(chain, prisma).tick();
  console.log(`   buyer ledger balance: ${fmt(await getSettledBalance(buyerAcct, prisma))}\n`);

  // --- 2. win an auction at $20 ------------------------------------------
  const listing = await createListing(
    seller.id,
    { title: 'Charizard — Base Set Holo (devnet)', startingBid: usdc('5'), photos: [] },
    prisma,
  );
  const { auctionId } = await startAuctionFromListing(listing.id, { durationSeconds: 20 }, clock, prisma);
  await placeBid({ auctionId, userId: buyer.id, amount: usdc('20') }, clock, prisma);
  clock.advance(21_000);
  await closeDueAuctions(clock, prisma);
  console.log('2) buyer won the auction at $20');

  // --- 3. settle -> escrow lock (treasury -> escrow on-chain) -------------
  const order = (await settleAuction(auctionId, escrow, clock, prisma))!;
  console.log(`3) order ${order.status}; escrowRef ${order.escrowRef}`);
  console.log(`   escrow on-chain balance: ${fmt(await chain.balance('escrow'))}`);
  console.log(`   buyer ledger available: ${fmt(await getSettledBalance(buyerAcct, prisma))}\n`);

  // --- 4. ship -> deliver -> release (95% seller / 5% buyback) -----------
  await markShipped(order.id, 'DEVNET-TRACK', clock, prisma);
  await markDelivered(order.id, clock, prisma);
  clock.advance(DISPUTE_WINDOW_MS + 1000);
  await processOrderTimers(escrow, clock, prisma);
  console.log('4) shipped -> delivered -> dispute window passed -> RELEASED');
  console.log(`   seller ledger balance: ${fmt(await getSettledBalance(sellerAcct, prisma))} (95%)`);
  console.log(`   buyback wallet on-chain: ${fmt(await chain.balance('buyback'))} (5%)`);
  console.log(`   escrow on-chain balance: ${fmt(await chain.balance('escrow'))}\n`);

  // --- 5. buyback worker (devnet: reserved; mainnet: real Jupiter swap) ---
  const buyback = await new BuybackWorker(new MockSwapper(), prisma).run();
  console.log(`5) buyback recorded: ${buyback ? fmt(buyback.amount) : 'none'} (reserved in buyback wallet — no $BID/LP on devnet)`);
  console.log(`   buyback pending pool: ${fmt(await getBuybackPending(prisma))}\n`);

  // --- 6. seller withdraws their proceeds to a real devnet address --------
  const sellerWallet = Keypair.generate().publicKey.toBase58();
  console.log(`6) seller withdraws ${fmt(usdc('19'))} to ${sellerWallet}`);
  const w = await requestWithdrawal(seller.id, sellerWallet, usdc('19'), chain, prisma);
  console.log(`   withdrawal ${w.status}${w.txSig ? `; on-chain: ${explorer(w.txSig)}` : ''}`);
  console.log(`   seller ledger balance now: ${fmt(await getSettledBalance(sellerAcct, prisma))}\n`);

  console.log('Done — deposit -> win -> escrow -> release -> buyback -> withdraw, on real devnet USDC.\n');
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error('\nFAILED:', err);
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});
