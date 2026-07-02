/**
 * A narrated walk through the ledger with simulated money — proof the engine
 * works end to end. Run with: npm run demo  (from packages/backend or root).
 */
import { prisma } from '../src/db.js';
import { ensureSystemAccounts } from '../src/bootstrap.js';
import {
  deposit,
  withdraw,
  refund,
  settlePurchase,
  getAvailableBalance,
  getSettledBalance,
  getSystemTotal,
  getOrCreateUserAccount,
} from '../src/ledger.js';
import { usdc, formatUsdc, SYSTEM_ACCOUNT_IDS } from '@bidit/shared';

async function show(label: string, accountId: string): Promise<void> {
  const balance = await getAvailableBalance(accountId, prisma);
  console.log(`   ${label.padEnd(22)} $${formatUsdc(balance)}`);
}

async function main(): Promise<void> {
  await ensureSystemAccounts(prisma);

  const stamp = Date.now();
  const buyer = await prisma.user.create({
    data: { handle: `buyer_${stamp}`, role: 'buyer' },
  });
  const seller = await prisma.user.create({
    data: { handle: `seller_${stamp}`, role: 'seller' },
  });
  const buyerAcct = await getOrCreateUserAccount(buyer.id, prisma);
  const sellerAcct = await getOrCreateUserAccount(seller.id, prisma);

  console.log('\n1) Buyer deposits $100 (simulated)');
  await deposit(
    { accountId: buyerAcct, amount: usdc('100'), idempotencyKey: `dep_${buyer.id}` },
    prisma,
  );
  await show('buyer available', buyerAcct);

  console.log('\n2) Same deposit webhook fires again (same idempotency key)');
  await deposit(
    { accountId: buyerAcct, amount: usdc('100'), idempotencyKey: `dep_${buyer.id}` },
    prisma,
  );
  await show('buyer available', buyerAcct);
  console.log('   -> still $100, not double-credited');

  console.log('\n3) Buyer wins a $25 card. Settle: 95% seller / 5% platform');
  const { platformFee, sellerProceeds } = await settlePurchase(
    {
      buyerAccountId: buyerAcct,
      sellerAccountId: sellerAcct,
      amount: usdc('25'),
      refId: 'demo-order-1',
    },
    prisma,
  );
  console.log(
    `   fee $${formatUsdc(platformFee)}  ->  seller gets $${formatUsdc(sellerProceeds)}`,
  );
  await show('buyer available', buyerAcct);
  await show('seller available', sellerAcct);

  console.log('\n4) Try to withdraw $80 from seller (only has $23.75) -> rejected');
  try {
    await withdraw({ accountId: sellerAcct, amount: usdc('80') }, prisma);
  } catch (err) {
    console.log(`   blocked: ${(err as Error).message}`);
  }

  console.log('\n5) Seller withdraws $20');
  await withdraw({ accountId: sellerAcct, amount: usdc('20') }, prisma);
  await show('seller available', sellerAcct);

  console.log('\n6) Refund buyer $5 of goodwill');
  await refund({ accountId: buyerAcct, amount: usdc('5'), refId: 'demo-order-1' }, prisma);
  await show('buyer available', buyerAcct);

  console.log('\nInvariants');
  const platformPool = await getSettledBalance(SYSTEM_ACCOUNT_IDS.PLATFORM, prisma);
  const externalBal = await getSettledBalance(SYSTEM_ACCOUNT_IDS.EXTERNAL, prisma);
  const systemTotal = await getSystemTotal(prisma);
  console.log(`   platform pool (funds $BID buyback)  $${formatUsdc(platformPool)}`);
  console.log(`   external boundary balance           $${formatUsdc(externalBal)}`);
  console.log(`   system total (must be exactly 0)    $${formatUsdc(systemTotal)}`);
  if (systemTotal !== 0n) {
    throw new Error('CONSERVATION VIOLATED: system total is not zero');
  }
  console.log('\nLedger conserved. Done.\n');

  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
