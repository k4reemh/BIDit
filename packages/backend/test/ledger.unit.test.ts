import { describe, it, expect, beforeEach } from 'vitest';
import { prisma } from '../src/db.js';
import {
  deposit,
  withdraw,
  refund,
  settlePurchase,
  getSettledBalance,
  getAvailableBalance,
  getSystemTotal,
} from '../src/ledger.js';
import { InsufficientFundsError, InvalidAmountError } from '../src/errors.js';
import { usdc, formatUsdc, splitAmount, SYSTEM_ACCOUNT_IDS } from '@bidit/shared';
import { resetDb, makeUser } from './setup.js';

beforeEach(async () => {
  await resetDb();
});

describe('deposits & balances', () => {
  it('credits the account and conserves the system', async () => {
    const buyer = await makeUser('buyer');
    await deposit({ accountId: buyer.accountId, amount: usdc('100') }, prisma);

    expect(await getSettledBalance(buyer.accountId, prisma)).toBe(usdc('100'));
    expect(await getAvailableBalance(buyer.accountId, prisma)).toBe(usdc('100'));
    // EXTERNAL is the negative mirror of money inside the system.
    expect(await getSettledBalance(SYSTEM_ACCOUNT_IDS.EXTERNAL, prisma)).toBe(usdc('-100'));
    expect(await getSystemTotal(prisma)).toBe(0n);
  });

  it('is idempotent on a repeated idempotencyKey', async () => {
    const buyer = await makeUser('buyer');
    const key = 'deposit-abc';
    await deposit({ accountId: buyer.accountId, amount: usdc('50'), idempotencyKey: key }, prisma);
    await deposit({ accountId: buyer.accountId, amount: usdc('50'), idempotencyKey: key }, prisma);
    await deposit({ accountId: buyer.accountId, amount: usdc('50'), idempotencyKey: key }, prisma);

    expect(await getSettledBalance(buyer.accountId, prisma)).toBe(usdc('50'));
    const entries = await prisma.ledgerEntry.count({ where: { accountId: buyer.accountId } });
    expect(entries).toBe(1);
  });
});

describe('withdrawals / debits', () => {
  it('reduces balance and conserves the system', async () => {
    const buyer = await makeUser('buyer');
    await deposit({ accountId: buyer.accountId, amount: usdc('100') }, prisma);
    await withdraw({ accountId: buyer.accountId, amount: usdc('30') }, prisma);

    expect(await getAvailableBalance(buyer.accountId, prisma)).toBe(usdc('70'));
    expect(await getSystemTotal(prisma)).toBe(0n);
  });

  it('rejects an overdraft and writes no ledger rows', async () => {
    const buyer = await makeUser('buyer');
    await deposit({ accountId: buyer.accountId, amount: usdc('10') }, prisma);

    await expect(
      withdraw({ accountId: buyer.accountId, amount: usdc('10.000001') }, prisma),
    ).rejects.toBeInstanceOf(InsufficientFundsError);

    // Balance untouched, still conserved.
    expect(await getAvailableBalance(buyer.accountId, prisma)).toBe(usdc('10'));
    expect(await getSystemTotal(prisma)).toBe(0n);
  });

  it('allows withdrawing the exact full balance to zero', async () => {
    const buyer = await makeUser('buyer');
    await deposit({ accountId: buyer.accountId, amount: usdc('42.5') }, prisma);
    await withdraw({ accountId: buyer.accountId, amount: usdc('42.5') }, prisma);
    expect(await getAvailableBalance(buyer.accountId, prisma)).toBe(0n);
  });

  it('rejects non-positive amounts', async () => {
    const buyer = await makeUser('buyer');
    await expect(
      deposit({ accountId: buyer.accountId, amount: 0n }, prisma),
    ).rejects.toBeInstanceOf(InvalidAmountError);
    await expect(
      deposit({ accountId: buyer.accountId, amount: -5n }, prisma),
    ).rejects.toBeInstanceOf(InvalidAmountError);
  });
});

describe('refunds', () => {
  it('credits the buyer back and conserves the system', async () => {
    const buyer = await makeUser('buyer');
    await deposit({ accountId: buyer.accountId, amount: usdc('20') }, prisma);
    await refund({ accountId: buyer.accountId, amount: usdc('5') }, prisma);
    expect(await getAvailableBalance(buyer.accountId, prisma)).toBe(usdc('25'));
    expect(await getSystemTotal(prisma)).toBe(0n);
  });
});

describe('purchase settlement (95/5 split)', () => {
  it('moves money buyer -> seller + platform and conserves exactly', async () => {
    const buyer = await makeUser('buyer');
    const seller = await makeUser('seller');
    await deposit({ accountId: buyer.accountId, amount: usdc('100') }, prisma);

    const { platformFee, sellerProceeds } = await settlePurchase(
      {
        buyerAccountId: buyer.accountId,
        sellerAccountId: seller.accountId,
        amount: usdc('25'),
        refId: 'order-1',
      },
      prisma,
    );

    expect(platformFee).toBe(usdc('1.25')); // 5% of 25
    expect(sellerProceeds).toBe(usdc('23.75')); // 95% of 25
    expect(await getAvailableBalance(buyer.accountId, prisma)).toBe(usdc('75'));
    expect(await getAvailableBalance(seller.accountId, prisma)).toBe(usdc('23.75'));
    expect(await getSettledBalance(SYSTEM_ACCOUNT_IDS.PLATFORM, prisma)).toBe(usdc('1.25'));
    expect(await getSystemTotal(prisma)).toBe(0n);
  });

  it('rejects settlement when the buyer is short', async () => {
    const buyer = await makeUser('buyer');
    const seller = await makeUser('seller');
    await deposit({ accountId: buyer.accountId, amount: usdc('10') }, prisma);

    await expect(
      settlePurchase(
        { buyerAccountId: buyer.accountId, sellerAccountId: seller.accountId, amount: usdc('25') },
        prisma,
      ),
    ).rejects.toBeInstanceOf(InsufficientFundsError);
    expect(await getSystemTotal(prisma)).toBe(0n);
  });
});

describe('money helpers', () => {
  it('parses and formats USDC precisely', () => {
    expect(usdc('10.50')).toBe(10_500_000n);
    expect(usdc('25')).toBe(25_000_000n);
    expect(usdc('0.000001')).toBe(1n);
    expect(usdc(25)).toBe(25_000_000n);
    expect(formatUsdc(10_500_000n)).toBe('10.5');
    expect(formatUsdc(25_000_000n)).toBe('25');
    expect(formatUsdc(1n)).toBe('0.000001');
  });

  it('rejects sub-micro precision', () => {
    expect(() => usdc('1.1234567')).toThrow();
  });

  it('split never leaks a micro-unit, even on tiny/odd amounts', () => {
    for (const amount of [1n, 3n, 7n, 999n, 1_000_001n, 33_333_333n, usdc('123.456789')]) {
      const { platformFee, sellerProceeds } = splitAmount(amount);
      expect(platformFee + sellerProceeds).toBe(amount);
      expect(platformFee).toBe((amount * 500n) / 10_000n);
      expect(platformFee).toBeGreaterThanOrEqual(0n);
    }
  });
});
