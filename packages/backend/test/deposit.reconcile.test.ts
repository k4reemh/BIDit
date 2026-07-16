import { describe, it, expect, beforeEach } from 'vitest';
import { prisma } from '../src/db.js';
import { MockChain } from '../src/chain/mock.js';
import { DepositWatcher, ensureDepositAddress } from '../src/deposits.js';
import { getSettledBalance } from '../src/ledger.js';
import { usdc } from '@bidit/shared';
import { resetDb, makeUser } from './setup.js';

beforeEach(async () => {
  await resetDb();
});

describe('durable deposit reconciliation', () => {
  it('records a durable receipt and credits it on a normal tick', async () => {
    const chain = new MockChain();
    const buyer = await makeUser('buyer');
    await ensureDepositAddress(buyer.userId, chain, prisma);

    chain.simulateDeposit(buyer.userId, usdc('30'), 'tx-a');
    expect(await new DepositWatcher(chain, prisma).tick()).toBe(1);

    expect(await getSettledBalance(buyer.accountId, prisma)).toBe(usdc('30'));
    const receipt = await prisma.depositReceipt.findUnique({ where: { txSig: 'tx-a' } });
    expect(receipt).not.toBeNull();
    expect(receipt!.creditedAt).not.toBeNull(); // marked credited
  });

  it('recovers a deposit swept before a crash: receipt exists but was never credited', async () => {
    const chain = new MockChain();
    const buyer = await makeUser('buyer');

    // Simulate the crash window: the sweep happened and a receipt was written,
    // but the process died before the ledger credit ran.
    await prisma.depositReceipt.create({
      data: { userId: buyer.userId, amountMicros: usdc('40'), txSig: 'lost-1' },
    });
    expect(await getSettledBalance(buyer.accountId, prisma)).toBe(0n); // uncredited

    // Startup reconcile finishes the job.
    const watcher = new DepositWatcher(chain, prisma);
    expect(await watcher.reconcile()).toBe(1);
    expect(await getSettledBalance(buyer.accountId, prisma)).toBe(usdc('40'));
    expect((await prisma.depositReceipt.findUnique({ where: { txSig: 'lost-1' } }))!.creditedAt).not.toBeNull();

    // Running reconcile again must NOT double-credit.
    expect(await watcher.reconcile()).toBe(0);
    expect(await getSettledBalance(buyer.accountId, prisma)).toBe(usdc('40'));
  });

  it('never double-credits when the same on-chain tx is re-delivered', async () => {
    const chain = new MockChain();
    const buyer = await makeUser('buyer');
    await ensureDepositAddress(buyer.userId, chain, prisma);
    const watcher = new DepositWatcher(chain, prisma);

    chain.simulateDeposit(buyer.userId, usdc('50'), 'tx-dup');
    await watcher.tick();
    // Re-deliver the identical signature (e.g. a poller replay).
    chain.simulateDeposit(buyer.userId, usdc('50'), 'tx-dup');
    await watcher.tick();

    expect(await getSettledBalance(buyer.accountId, prisma)).toBe(usdc('50')); // credited once
    expect(await prisma.depositReceipt.count({ where: { txSig: 'tx-dup' } })).toBe(1); // one receipt
  });

  it('is resilient if the credit landed but marking creditedAt was lost (idempotent re-credit)', async () => {
    const chain = new MockChain();
    const buyer = await makeUser('buyer');
    const accountId = buyer.accountId;

    // Simulate: credit succeeded on-chain-side but the creditedAt flip was lost, so
    // the receipt still looks pending AND a ledger entry already exists for it.
    const { deposit } = await import('../src/ledger.js');
    await deposit({ accountId, amount: usdc('25'), refId: 'tx-half', idempotencyKey: 'chain-deposit:tx-half' }, prisma);
    await prisma.depositReceipt.create({ data: { userId: buyer.userId, amountMicros: usdc('25'), txSig: 'tx-half' } });
    expect(await getSettledBalance(accountId, prisma)).toBe(usdc('25'));

    // Reconcile re-runs the (idempotent) credit and marks the receipt — no extra money.
    await new DepositWatcher(chain, prisma).reconcile();
    expect(await getSettledBalance(accountId, prisma)).toBe(usdc('25'));
    expect((await prisma.depositReceipt.findUnique({ where: { txSig: 'tx-half' } }))!.creditedAt).not.toBeNull();
  });
});
