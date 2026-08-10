import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { prisma } from '../src/db.js';
import { MockChain } from '../src/chain/mock.js';
import { DepositWatcher, ensureDepositAddress, formatSol } from '../src/deposits.js';
import { TreasurySwapWorker, totalAutoSwappedUsdcMicros } from '../src/treasury-swap.js';
import { reconcileWallets } from '../src/audit.js';
import { getAvailableBalance, getOrCreateUserAccount } from '../src/ledger.js';
import { resetDb, makeUser } from './setup.js';

// A fixed, trustworthy price so tests are deterministic (no network).
const PRICE = { usdMicro: 76_520_000n, source: 'pyth+coinbase' as const, at: 0 };
const priceFn = async () => PRICE;

const ORIG = { ...process.env };
beforeEach(async () => {
  await resetDb();
  process.env.BIDIT_SOL_SPREAD_BPS = '150'; // 1.5%
  delete process.env.BIDIT_SOL_MIN_LAMPORTS;
  delete process.env.BIDIT_SOL_DEPOSITS;
});
afterEach(() => {
  process.env = { ...ORIG };
});

async function balance(userId: string): Promise<bigint> {
  const accountId = await getOrCreateUserAccount(userId, prisma);
  return getAvailableBalance(accountId, prisma);
}

describe('native SOL deposits', () => {
  it("credits Kareem's example: 2 SOL @ $76.52 − 1.5% = $150.744", async () => {
    const chain = new MockChain();
    const buyer = await makeUser('buyer');
    await ensureDepositAddress(buyer.userId, chain, prisma);
    chain.simulateSolDeposit(buyer.userId, 2_000_000_000n); // 2 SOL

    const watcher = new DepositWatcher(chain, prisma, 5000, undefined, priceFn);
    await watcher.tick();

    expect(await balance(buyer.userId)).toBe(150_744_400n); // $150.7444
    // Receipt carries the full conversion audit trail.
    const r = await prisma.depositReceipt.findFirst({ where: { userId: buyer.userId, asset: 'SOL' } });
    expect(r!.lamports).toBe(2_000_000_000n);
    expect(r!.amountMicros).toBe(150_744_400n);
    expect(r!.priceUsdMicro).toBe(76_520_000n);
    expect(r!.spreadBps).toBe(150);
    expect(r!.priceSource).toBe('pyth+coinbase');
    expect(r!.creditedAt).not.toBeNull();
    // The SOL was swept into treasury.
    expect(chain.sweptLamports()).toBe(2_000_000_000n);
  });

  it('is idempotent: re-ticking never double-credits the same sweep', async () => {
    const chain = new MockChain();
    const buyer = await makeUser('buyer');
    await ensureDepositAddress(buyer.userId, chain, prisma);
    chain.simulateSolDeposit(buyer.userId, 1_000_000_000n);
    const watcher = new DepositWatcher(chain, prisma, 5000, undefined, priceFn);
    await watcher.tick();
    const once = await balance(buyer.userId);
    await watcher.tick();
    await watcher.creditPending();
    expect(await balance(buyer.userId)).toBe(once);
    expect(await prisma.depositReceipt.count({ where: { asset: 'SOL' } })).toBe(1);
  });

  it('a dead oracle delays the credit but never loses it (retry succeeds)', async () => {
    const chain = new MockChain();
    const buyer = await makeUser('buyer');
    await ensureDepositAddress(buyer.userId, chain, prisma);
    chain.simulateSolDeposit(buyer.userId, 2_000_000_000n);

    let up = false;
    const flaky = async () => {
      if (!up) throw new Error('oracle down');
      return PRICE;
    };
    const watcher = new DepositWatcher(chain, prisma, 5000, undefined, flaky);
    await watcher.tick(); // sweep + record, but pricing fails
    // Receipt exists, unpriced, uncredited: money is safe, not yet credited.
    const pending = await prisma.depositReceipt.findFirst({ where: { asset: 'SOL' } });
    expect(pending!.creditedAt).toBeNull();
    expect(pending!.priceUsdMicro).toBeNull();
    expect(await balance(buyer.userId)).toBe(0n);

    up = true;
    await watcher.creditPending(); // oracle back → credit lands
    expect(await balance(buyer.userId)).toBe(150_744_400n);
  });

  it('leaves sub-threshold dust unswept', async () => {
    process.env.BIDIT_SOL_MIN_LAMPORTS = '1000000'; // 0.001 SOL
    const chain = new MockChain();
    const buyer = await makeUser('buyer');
    await ensureDepositAddress(buyer.userId, chain, prisma);
    chain.simulateSolDeposit(buyer.userId, 500_000n); // dust, below threshold
    const watcher = new DepositWatcher(chain, prisma, 5000, undefined, priceFn);
    await watcher.tick();
    expect(await balance(buyer.userId)).toBe(0n);
    expect(await prisma.depositReceipt.count()).toBe(0);
    expect(chain.sweptLamports()).toBe(0n);
  });

  it('respects the BIDIT_SOL_DEPOSITS=no kill switch', async () => {
    process.env.BIDIT_SOL_DEPOSITS = 'no';
    const chain = new MockChain();
    const buyer = await makeUser('buyer');
    await ensureDepositAddress(buyer.userId, chain, prisma);
    chain.simulateSolDeposit(buyer.userId, 2_000_000_000n);
    await new DepositWatcher(chain, prisma, 5000, undefined, priceFn).tick();
    expect(await balance(buyer.userId)).toBe(0n);
    expect(await prisma.depositReceipt.count()).toBe(0);
  });

  it('formatSol renders lamports cleanly', () => {
    expect(formatSol(2_000_000_000n)).toBe('2');
    expect(formatSol(1_503_000_000n)).toBe('1.503');
    expect(formatSol(500_000n)).toBe('0.0005');
    expect(formatSol(0n)).toBe('0');
  });
});

describe('treasury SOL→USDC auto-swap', () => {
  it('converts swept SOL to USDC, banks the spread, and records the swap', async () => {
    process.env.BIDIT_TREASURY_SOL_RESERVE_LAMPORTS = '0';
    process.env.BIDIT_MIN_SWAP_LAMPORTS = '1';
    const chain = new MockChain();
    chain.setSwapPrice(76.52); // market rate, no spread on the swap itself
    const buyer = await makeUser('buyer');
    await ensureDepositAddress(buyer.userId, chain, prisma);
    chain.simulateSolDeposit(buyer.userId, 2_000_000_000n);
    await new DepositWatcher(chain, prisma, 5000, undefined, priceFn).tick();

    // User credited $150.744 (with spread); treasury holds 2 SOL.
    const userCredit = await balance(buyer.userId);
    expect(chain.sweptLamports()).toBe(2_000_000_000n);

    const usdcOut = await new TreasurySwapWorker(chain, prisma, 60_000).tick();
    // Swap yields ~$153.04 (market, no spread) → more than the $150.744 credited.
    expect(usdcOut).toBe(153_040_000n);
    expect(usdcOut).toBeGreaterThan(userCredit); // the spread is real profit
    expect(await chain.solBalanceLamports('treasury')).toBe(0n); // all SOL converted
    expect(await totalAutoSwappedUsdcMicros(prisma)).toBe(153_040_000n);
    const swap = await prisma.treasurySwap.findFirst();
    expect(swap!.lamportsIn).toBe(2_000_000_000n);
    expect(swap!.usdcMicrosOut).toBe(153_040_000n);
  });

  it('keeps a SOL reserve for fees', async () => {
    process.env.BIDIT_TREASURY_SOL_RESERVE_LAMPORTS = '500000000'; // 0.5 SOL
    process.env.BIDIT_MIN_SWAP_LAMPORTS = '1';
    const chain = new MockChain();
    chain.setSwapPrice(76.52);
    const buyer = await makeUser('buyer');
    await ensureDepositAddress(buyer.userId, chain, prisma);
    chain.simulateSolDeposit(buyer.userId, 2_000_000_000n);
    await new DepositWatcher(chain, prisma, 5000, undefined, priceFn).tick();

    await new TreasurySwapWorker(chain, prisma).tick();
    expect(await chain.solBalanceLamports('treasury')).toBe(500_000_000n); // reserve untouched
  });

  it('does nothing when the excess is below the min-swap threshold', async () => {
    process.env.BIDIT_TREASURY_SOL_RESERVE_LAMPORTS = '0';
    process.env.BIDIT_MIN_SWAP_LAMPORTS = '50000000'; // 0.05 SOL
    const chain = new MockChain();
    const buyer = await makeUser('buyer');
    await ensureDepositAddress(buyer.userId, chain, prisma);
    chain.simulateSolDeposit(buyer.userId, 10_000_000n); // 0.01 SOL, below min-swap
    // Deposit min is default 0.001, so it sweeps + credits, but swap won't fire.
    await new DepositWatcher(chain, prisma, 5000, undefined, priceFn).tick();
    const out = await new TreasurySwapWorker(chain, prisma).tick();
    expect(out).toBe(0n);
    expect(await prisma.treasurySwap.count()).toBe(0);
  });

  it('a failed swap leaves SOL safely in treasury and retries', async () => {
    process.env.BIDIT_TREASURY_SOL_RESERVE_LAMPORTS = '0';
    process.env.BIDIT_MIN_SWAP_LAMPORTS = '1';
    const chain = new MockChain();
    chain.setSwapPrice(76.52);
    const buyer = await makeUser('buyer');
    await ensureDepositAddress(buyer.userId, chain, prisma);
    chain.simulateSolDeposit(buyer.userId, 2_000_000_000n);
    await new DepositWatcher(chain, prisma, 5000, undefined, priceFn).tick();

    const worker = new TreasurySwapWorker(chain, prisma);
    chain.failNextSwap();
    expect(await worker.tick()).toBe(0n); // swap failed
    expect(await chain.solBalanceLamports('treasury')).toBe(2_000_000_000n); // SOL untouched
    expect(await prisma.treasurySwap.count()).toBe(0);
    // Next pass succeeds.
    expect(await worker.tick()).toBe(153_040_000n);
    expect(await chain.solBalanceLamports('treasury')).toBe(0n);
  });
});

describe('audit stays balanced across SOL deposit + swap', () => {
  it('treasury is not short while holding SOL, and exact after the swap', async () => {
    process.env.BIDIT_TREASURY_SOL_RESERVE_LAMPORTS = '0';
    process.env.BIDIT_MIN_SWAP_LAMPORTS = '1';
    const chain = new MockChain();
    chain.setSwapPrice(76.52);
    const buyer = await makeUser('buyer');
    await ensureDepositAddress(buyer.userId, chain, prisma);
    chain.simulateSolDeposit(buyer.userId, 2_000_000_000n);
    await new DepositWatcher(chain, prisma, 5000, undefined, priceFn).tick();

    // Before swap: treasury holds SOL (0 USDC) but the audit values it and finds
    // treasury NOT short (SOL market value ≥ the USDC liability credited).
    const before = await reconcileWallets(chain, prisma, priceFn);
    expect(before.treasurySolLamports).toBe(2_000_000_000n);
    expect(before.solPriced).toBe(true);
    expect(before.reconciled).toBe(true);
    expect(before.rows.find((r) => r.wallet === 'treasury')!.diff).toBeGreaterThanOrEqual(0n);

    // After swap: treasury holds USDC ≥ liabilities, no SOL left.
    await new TreasurySwapWorker(chain, prisma).tick();
    const after = await reconcileWallets(chain, prisma, priceFn);
    expect(after.treasurySolLamports).toBe(0n);
    expect(after.reconciled).toBe(true);
    expect(after.rows.find((r) => r.wallet === 'treasury')!.diff).toBeGreaterThanOrEqual(0n);
  });
});
