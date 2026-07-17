import { describe, it, expect, beforeEach } from 'vitest';
import { prisma } from '../src/db.js';
import { MockChain } from '../src/chain/mock.js';
import { DepositWatcher, ensureDepositAddress } from '../src/deposits.js';
import { reconcileWallets } from '../src/audit.js';
import { usdc } from '@bidit/shared';
import { resetDb, makeUser } from './setup.js';

beforeEach(async () => { await resetDb(); });

describe('reconcileWallets', () => {
  it('reports every wallet matching its ledger account after a deposit', async () => {
    const chain = new MockChain();
    const buyer = await makeUser('buyer');
    await ensureDepositAddress(buyer.userId, chain, prisma);
    chain.simulateDeposit(buyer.userId, usdc('100'));
    await new DepositWatcher(chain, prisma).tick(); // sweeps to treasury + credits ledger

    const recon = await reconcileWallets(chain, prisma);
    const by = Object.fromEntries(recon.rows.map((r) => [r.wallet, r]));
    // treasury holds the pooled user balance; the segregated pools are empty.
    expect(by.treasury.chain).toBe(usdc('100'));
    expect(by.treasury.ledger).toBe(usdc('100'));
    for (const w of ['treasury', 'escrow', 'buyback', 'fee']) expect(by[w].diff).toBe(0n);
    expect(recon.reconciled).toBe(true);
    expect(recon.pendingLegs).toBe(0);
  });

  it('surfaces in-flight outbox legs and flags a real divergence', async () => {
    const chain = new MockChain();
    const buyer = await makeUser('buyer');
    await ensureDepositAddress(buyer.userId, chain, prisma);
    chain.simulateDeposit(buyer.userId, usdc('100'));
    await new DepositWatcher(chain, prisma).tick();

    // A queued (not-yet-settled) leg is reported so a physical lag is explainable.
    await prisma.chainTransfer.create({ data: { key: 'lock:x', fromWallet: 'treasury', toWallet: 'escrow', amount: usdc('5') } });
    expect((await reconcileWallets(chain, prisma)).pendingLegs).toBe(1);

    // Move real USDC out-of-band (no matching ledger entry) → a true mismatch.
    await chain.transfer('treasury', chain.walletAddress('buyback'), usdc('3'));
    const recon = await reconcileWallets(chain, prisma);
    expect(recon.reconciled).toBe(false);
    const buyback = recon.rows.find((r) => r.wallet === 'buyback')!;
    expect(buyback.diff).toBe(usdc('3')); // chain has $3 the ledger doesn't
  });
});
