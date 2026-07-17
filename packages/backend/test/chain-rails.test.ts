import { describe, it, expect, beforeEach } from 'vitest';
import { prisma } from '../src/db.js';
import { ManualClock } from '../src/clock.js';
import { MockChain } from '../src/chain/index.js';
import { ProgramEscrow } from '../src/escrow.js';
import { ChainSettler } from '../src/chain-settle.js';
import { DepositWatcher, ensureDepositAddress } from '../src/deposits.js';
import { requestWithdrawal } from '../src/withdrawals.js';
import { BuybackWorker, MockSwapper } from '../src/buyback.js';
import { placeBid, closeDueAuctions } from '../src/auction.js';
import { settleAuction, markShipped, markDelivered, processOrderTimers, DISPUTE_WINDOW_MS } from '../src/orders.js';
import {
  getSettledBalance,
  getAvailableBalance,
  getBuybackPending,
  getSystemTotal,
  getOrCreateUserAccount,
} from '../src/ledger.js';
import { InsufficientFundsError } from '../src/errors.js';
import { usdc, AuctionStatus, OrderStatus, SYSTEM_ACCOUNT_IDS } from '@bidit/shared';
import { resetDb, makeUser, makeRunningAuction } from './setup.js';

const T0 = new Date('2026-01-01T00:00:00.000Z').getTime();

beforeEach(async () => {
  await resetDb();
});

async function fundViaChain(userId: string, chain: MockChain, amount: string): Promise<void> {
  await ensureDepositAddress(userId, chain, prisma);
  chain.simulateDeposit(userId, usdc(amount));
  await new DepositWatcher(chain, prisma).tick();
}

/** Drive the durable escrow outbox to the (mock) chain until it's empty. */
async function drainChain(chain: MockChain): Promise<void> {
  const settler = new ChainSettler(chain, prisma);
  for (let i = 0; i < 5; i++) {
    if ((await prisma.chainTransfer.count({ where: { status: { in: ['PENDING', 'SUBMITTED'] } } })) === 0) return;
    await settler.tick();
  }
}

describe('deposit rail (chain -> ledger)', () => {
  it('credits the ledger from a confirmed inbound deposit, idempotently', async () => {
    const chain = new MockChain();
    const buyer = await makeUser('buyer');
    await ensureDepositAddress(buyer.userId, chain, prisma);

    chain.simulateDeposit(buyer.userId, usdc('50'), 'tx-1');
    const watcher = new DepositWatcher(chain, prisma);
    expect(await watcher.tick()).toBe(1);
    expect(await getSettledBalance(buyer.accountId, prisma)).toBe(usdc('50'));

    // Re-deliver the same on-chain tx — must NOT double-credit.
    chain.simulateDeposit(buyer.userId, usdc('50'), 'tx-1');
    await watcher.tick();
    expect(await getSettledBalance(buyer.accountId, prisma)).toBe(usdc('50'));
    expect(await getSystemTotal(prisma)).toBe(0n);
  });
});

describe('withdrawal rail (ledger -> chain)', () => {
  it('debits the ledger and sends on-chain', async () => {
    const chain = new MockChain();
    const buyer = await makeUser('buyer');
    await fundViaChain(buyer.userId, chain, '100');

    const w = await requestWithdrawal(buyer.userId, 'SomeExternalWallet', usdc('30'), chain, prisma);
    expect(w.status).toBe('CONFIRMED');
    expect(w.txSig).toBeTruthy();
    expect(await getSettledBalance(buyer.accountId, prisma)).toBe(usdc('70'));
    expect(await chain.balance('SomeExternalWallet')).toBe(usdc('30'));
    expect(await getSystemTotal(prisma)).toBe(0n);
  });

  it('cannot withdraw funds locked in a hold (available = settled − holds)', async () => {
    const chain = new MockChain();
    const clock = new ManualClock(T0);
    const buyer = await makeUser('buyer');
    await fundViaChain(buyer.userId, chain, '100');

    // Lead an auction at $60 -> $60 held, $40 available.
    const auction = await makeRunningAuction({ startingBid: '60', clock });
    await placeBid({ auctionId: auction.auctionId, userId: buyer.userId, amount: usdc('60') }, clock, prisma);

    await expect(
      requestWithdrawal(buyer.userId, 'addr', usdc('50'), chain, prisma),
    ).rejects.toBeInstanceOf(InsufficientFundsError);
    // Balance untouched; the failed withdrawal is recorded as FAILED.
    expect(await getSettledBalance(buyer.accountId, prisma)).toBe(usdc('100'));
    expect((await prisma.withdrawal.findFirst({ where: { userId: buyer.userId } }))?.status).toBe('FAILED');
  });
});

describe('full on-chain settlement flow (mock chain)', () => {
  it('deposit -> bid -> win -> escrow lock -> ship -> deliver -> release -> seller paid + buyback funded', async () => {
    const chain = new MockChain();
    const escrow = new ProgramEscrow(chain, prisma);
    const clock = new ManualClock(T0);

    // 1) Deposit $100 from chain.
    const buyer = await makeUser('buyer');
    await fundViaChain(buyer.userId, chain, '100');
    expect(await getSettledBalance(buyer.accountId, prisma)).toBe(usdc('100'));
    expect(await chain.balance('treasury')).toBe(usdc('100'));

    // 2) Win an auction at $20.
    const auction = await makeRunningAuction({ startingBid: '5', clock, durationSeconds: 20 });
    await placeBid({ auctionId: auction.auctionId, userId: buyer.userId, amount: usdc('20') }, clock, prisma);
    clock.advance(21_000);
    expect((await closeDueAuctions(clock, prisma))[0]?.status).toBe(AuctionStatus.SETTLING);

    // 3) Settle into escrow — funds move treasury -> escrow on-chain.
    const order = (await settleAuction(auction.auctionId, escrow, clock, prisma))!;
    expect(order.status).toBe(OrderStatus.LOCKED);
    expect(await getSettledBalance(SYSTEM_ACCOUNT_IDS.ESCROW, prisma)).toBe(usdc('20')); // ledger: synchronous
    await drainChain(chain); // settle the treasury -> escrow leg on-chain
    expect(await chain.balance('escrow')).toBe(usdc('20'));
    expect(await chain.balance('treasury')).toBe(usdc('80'));
    expect(await getAvailableBalance(buyer.accountId, prisma)).toBe(usdc('80'));

    // 4) Ship, deliver, dispute window passes -> release.
    await markShipped(order.id, 'TRACK-1', clock, prisma);
    await markDelivered(order.id, clock, prisma);
    clock.advance(DISPUTE_WINDOW_MS + 1000);
    expect((await processOrderTimers(escrow, clock, prisma)).released).toEqual([order.id]);

    const sellerAcct = await getOrCreateUserAccount(auction.sellerId, prisma);
    expect(await getSettledBalance(sellerAcct, prisma)).toBe(usdc('19')); // 95% (ledger: synchronous)
    expect(await getBuybackPending(prisma)).toBe(usdc('0.8')); // 4% buyback pool
    expect(await getSettledBalance(SYSTEM_ACCOUNT_IDS.FEE, prisma)).toBe(usdc('0.2')); // 1% fee pool
    await drainChain(chain); // settle the escrow -> treasury / buyback / fee legs on-chain
    expect(await chain.balance('escrow')).toBe(0n);
    expect(await chain.balance('buyback')).toBe(usdc('0.8'));
    expect(await chain.balance('fee')).toBe(usdc('0.2'));
    expect(await chain.balance('treasury')).toBe(usdc('99')); // 80 + 19 back to pool

    // 5) Buyback worker spends the 4% pool on $BID.
    const swapper = new MockSwapper();
    const worker = new BuybackWorker(swapper, prisma);
    const buyback = await worker.run();
    expect(buyback?.amount).toBe(usdc('0.8'));
    expect(swapper.swaps).toEqual([usdc('0.8')]);
    expect(await getBuybackPending(prisma)).toBe(0n); // pool drained
    expect(await prisma.buyback.count()).toBe(1);
    expect(await getSystemTotal(prisma)).toBe(0n); // ledger still conserved end-to-end
  });
});
