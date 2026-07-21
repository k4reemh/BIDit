/**
 * The balance ledger — BIDit's financial spine.
 *
 * Design rules (do not break):
 *  1. The server is authoritative. Amounts are bigint micro-units, never floats.
 *  2. Append-only. We only ever INSERT LedgerEntry rows; never UPDATE/DELETE.
 *  3. Double-entry. Every operation posts legs that sum to exactly zero, so the
 *     grand total across all accounts is invariantly zero. Deposits/withdrawals
 *     balance against the EXTERNAL system account; the platform fee balances the
 *     buyer/seller split.
 *  4. No double-spend. Any operation that could push a USER account negative
 *     takes a row lock on the Account (SELECT ... FOR UPDATE) and re-checks the
 *     available balance inside the same transaction before posting.
 *
 *  available_balance = settled_balance - active_holds
 *  settled_balance   = SUM(ledger.amount WHERE accountId = account)
 *  active_holds      = funds locked as current high bidder (Chunk 3; 0 for now)
 */

import {
  LedgerType,
  LedgerRefType,
  AccountKind,
  HoldStatus,
  SYSTEM_ACCOUNT_IDS,
  splitAmount,
  splitSale,
  type Micros,
} from '@bidit/shared';
import { prisma as defaultPrisma } from './db.js';
import type { PrismaClient } from './db.js';
import {
  InsufficientFundsError,
  InvalidAmountError,
  LedgerImbalanceError,
} from './errors.js';

/** Interactive-transaction client handed to us by prisma.$transaction. */
type Tx = Parameters<Parameters<PrismaClient['$transaction']>[0]>[0];
/** Anything we can read balances from — the base client or a transaction. */
type Reader = PrismaClient | Tx;

const TX_OPTS = { timeout: 15_000, maxWait: 15_000 } as const;

// ---------------------------------------------------------------------------
// Low-level primitives
// ---------------------------------------------------------------------------

export interface LedgerLeg {
  accountId: string;
  /** Signed micro-units. Positive = credit, negative = debit. */
  amount: bigint;
  type: LedgerType;
  refType: LedgerRefType;
  refId?: string | null;
  idempotencyKey?: string | null;
}

/**
 * Post a balanced set of legs atomically. Enforces the double-entry invariant:
 * the legs must sum to zero. Zero-amount legs (e.g. a rounded-down 0 fee) are
 * accepted and simply not written.
 */
async function postEntries(tx: Tx, legs: LedgerLeg[]): Promise<void> {
  const sum = legs.reduce((acc, leg) => acc + leg.amount, 0n);
  if (sum !== 0n) {
    throw new LedgerImbalanceError(sum);
  }
  const nonZero = legs.filter((leg) => leg.amount !== 0n);
  if (nonZero.length === 0) return;
  await tx.ledgerEntry.createMany({
    data: nonZero.map((leg) => ({
      accountId: leg.accountId,
      amount: leg.amount,
      type: leg.type,
      refType: leg.refType,
      refId: leg.refId ?? null,
      idempotencyKey: leg.idempotencyKey ?? null,
    })),
  });
}

/** Take a row lock on an account so concurrent balance-changing ops serialize. */
async function lockAccount(tx: Tx, accountId: string): Promise<void> {
  await tx.$queryRaw`SELECT id FROM "Account" WHERE id = ${accountId} FOR UPDATE`;
}

/**
 * An internal wallet→wallet USDC move to enqueue in the durable ChainTransfer
 * outbox — recorded in the SAME transaction as its ledger move, so the physical
 * transfer is never lost or double-recorded relative to the ledger truth. A
 * ChainSettler drives it to CONFIRMED out of band (see chain-settle.ts).
 */
export interface ChainLeg {
  /** Idempotency key, one per logical leg (e.g. `lock:<orderId>`). */
  key: string;
  fromWallet: string;
  toWallet: string;
  amount: bigint;
  memo?: string;
}

/** Insert outbox legs inside the caller's transaction. Idempotent (unique key,
 *  skipDuplicates); zero/negative legs are dropped. No-op when legs is empty. */
async function enqueueChainLegs(tx: Tx, legs?: ChainLeg[]): Promise<void> {
  const data = (legs ?? [])
    .filter((l) => l.amount > 0n)
    .map((l) => ({ key: l.key, fromWallet: l.fromWallet, toWallet: l.toWallet, amount: l.amount, memo: l.memo ?? null }));
  if (data.length === 0) return;
  await tx.chainTransfer.createMany({ data, skipDuplicates: true });
}

// ---------------------------------------------------------------------------
// Balance reads
// ---------------------------------------------------------------------------

export async function getSettledBalance(
  accountId: string,
  reader: Reader = defaultPrisma,
): Promise<bigint> {
  const result = await reader.ledgerEntry.aggregate({
    _sum: { amount: true },
    where: { accountId },
  });
  return result._sum.amount ?? 0n;
}

/**
 * Funds currently locked because this account is the leading bidder on one or
 * more auctions. The sum of ACTIVE holds. This is what makes a user unable to
 * lead auctions worth more than they actually have.
 */
export async function getActiveHolds(
  accountId: string,
  reader: Reader = defaultPrisma,
): Promise<bigint> {
  const result = await reader.hold.aggregate({
    _sum: { amount: true },
    where: { accountId, status: HoldStatus.ACTIVE },
  });
  return result._sum.amount ?? 0n;
}

export async function getAvailableBalance(
  accountId: string,
  reader: Reader = defaultPrisma,
): Promise<bigint> {
  const [settled, holds] = await Promise.all([
    getSettledBalance(accountId, reader),
    getActiveHolds(accountId, reader),
  ]);
  return settled - holds;
}

/** Grand total across every account. Invariantly 0 (double-entry). */
export async function getSystemTotal(reader: Reader = defaultPrisma): Promise<bigint> {
  const result = await reader.ledgerEntry.aggregate({ _sum: { amount: true } });
  return result._sum.amount ?? 0n;
}

// ---------------------------------------------------------------------------
// Boundary operations (money crossing the system edge, balanced vs EXTERNAL)
// ---------------------------------------------------------------------------

export interface BoundaryParams {
  accountId: string;
  /** Positive magnitude in micro-units. */
  amount: Micros;
  refType: LedgerRefType;
  refId?: string | null;
  idempotencyKey?: string | null;
}

/**
 * Bring money INTO an account from the EXTERNAL boundary (deposit / refund).
 * Idempotent when an idempotencyKey is supplied.
 */
export async function credit(
  params: BoundaryParams & { type?: LedgerType },
  prisma: PrismaClient = defaultPrisma,
): Promise<void> {
  assertPositive(params.amount);
  const type = params.type ?? LedgerType.DEPOSIT;
  if (params.idempotencyKey && (await alreadyApplied(params.idempotencyKey, prisma))) {
    return;
  }
  try {
    await prisma.$transaction(
      (tx) =>
        postEntries(tx, [
          {
            accountId: SYSTEM_ACCOUNT_IDS.EXTERNAL,
            amount: -params.amount,
            type,
            refType: params.refType,
            refId: params.refId,
          },
          {
            accountId: params.accountId,
            amount: params.amount,
            type,
            refType: params.refType,
            refId: params.refId,
            idempotencyKey: params.idempotencyKey,
          },
        ]),
      TX_OPTS,
    );
  } catch (err) {
    if (isUniqueViolation(err)) return; // concurrent duplicate of same idempotencyKey
    throw err;
  }
}

/**
 * Move money OUT of an account to the EXTERNAL boundary (withdrawal). Locks the
 * account and re-checks available funds inside the transaction.
 */
export async function debit(
  params: BoundaryParams & { type?: LedgerType },
  prisma: PrismaClient = defaultPrisma,
): Promise<void> {
  assertPositive(params.amount);
  const type = params.type ?? LedgerType.WITHDRAWAL;
  if (params.idempotencyKey && (await alreadyApplied(params.idempotencyKey, prisma))) {
    return;
  }
  try {
    await prisma.$transaction(async (tx) => {
      await lockAccount(tx, params.accountId);
      const available = await availableWithinTx(tx, params.accountId);
      if (available < params.amount) {
        throw new InsufficientFundsError(params.accountId, available, params.amount);
      }
      await postEntries(tx, [
        {
          accountId: params.accountId,
          amount: -params.amount,
          type,
          refType: params.refType,
          refId: params.refId,
          idempotencyKey: params.idempotencyKey,
        },
        {
          accountId: SYSTEM_ACCOUNT_IDS.EXTERNAL,
          amount: params.amount,
          type,
          refType: params.refType,
          refId: params.refId,
        },
      ]);
    }, TX_OPTS);
  } catch (err) {
    if (isUniqueViolation(err)) return;
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Semantic wrappers
// ---------------------------------------------------------------------------

export interface DepositParams {
  accountId: string;
  amount: Micros;
  /** External reference (e.g. the on-chain deposit tx id). */
  refId?: string | null;
  idempotencyKey?: string | null;
}

export function deposit(params: DepositParams, prisma: PrismaClient = defaultPrisma) {
  return credit(
    {
      accountId: params.accountId,
      amount: params.amount,
      type: LedgerType.DEPOSIT,
      refType: LedgerRefType.DEPOSIT,
      refId: params.refId,
      idempotencyKey: params.idempotencyKey,
    },
    prisma,
  );
}

export function withdraw(params: DepositParams, prisma: PrismaClient = defaultPrisma) {
  return debit(
    {
      accountId: params.accountId,
      amount: params.amount,
      type: LedgerType.WITHDRAWAL,
      refType: LedgerRefType.WITHDRAWAL,
      refId: params.refId,
      idempotencyKey: params.idempotencyKey,
    },
    prisma,
  );
}

export function refund(params: DepositParams, prisma: PrismaClient = defaultPrisma) {
  return credit(
    {
      accountId: params.accountId,
      amount: params.amount,
      type: LedgerType.REFUND,
      refType: LedgerRefType.ADJUSTMENT,
      refId: params.refId,
      idempotencyKey: params.idempotencyKey,
    },
    prisma,
  );
}

// ---------------------------------------------------------------------------
// Internal transfer: settle a purchase (buyer -> seller + platform fee)
// ---------------------------------------------------------------------------

export interface SettlePurchaseParams {
  buyerAccountId: string;
  sellerAccountId: string;
  /** Winning bid amount in micro-units. */
  amount: Micros;
  /** Order id this settlement belongs to. */
  refId?: string | null;
  feeBps?: bigint;
  /**
   * In the live flow the buyer's funds are already held, so this can be false.
   * Defaults true (lock + check) for standalone safety.
   */
  checkBuyerFunds?: boolean;
}

/**
 * The 95/5 split that powers the flywheel: buyer is debited the full amount,
 * the seller is credited 95%, and the PLATFORM account accrues the 5% cut that
 * funds $BID buybacks. All three legs sum to zero — money is conserved exactly.
 */
export async function settlePurchase(
  params: SettlePurchaseParams,
  prisma: PrismaClient = defaultPrisma,
): Promise<{ platformFee: bigint; sellerProceeds: bigint }> {
  assertPositive(params.amount);
  const { platformFee, sellerProceeds } = splitAmount(params.amount, params.feeBps);
  await prisma.$transaction(async (tx) => {
    if (params.checkBuyerFunds !== false) {
      await lockAccount(tx, params.buyerAccountId);
      const available = await availableWithinTx(tx, params.buyerAccountId);
      if (available < params.amount) {
        throw new InsufficientFundsError(params.buyerAccountId, available, params.amount);
      }
    }
    await postEntries(tx, [
      {
        accountId: params.buyerAccountId,
        amount: -params.amount,
        type: LedgerType.PURCHASE_DEBIT,
        refType: LedgerRefType.ORDER,
        refId: params.refId,
      },
      {
        accountId: params.sellerAccountId,
        amount: sellerProceeds,
        type: LedgerType.PAYOUT_CREDIT,
        refType: LedgerRefType.ORDER,
        refId: params.refId,
      },
      {
        accountId: SYSTEM_ACCOUNT_IDS.PLATFORM,
        amount: platformFee,
        type: LedgerType.PLATFORM_FEE,
        refType: LedgerRefType.ORDER,
        refId: params.refId,
      },
    ]);
  }, TX_OPTS);
  return { platformFee, sellerProceeds };
}

/**
 * Direct sale settlement (no escrow, no fee): capture the winner's ACTIVE hold
 * and move the full amount buyer -> seller in one atomic, idempotent step. Used
 * for the no-escrow payout mode — the seller's settled balance rises immediately
 * and is withdrawable. Mirrors escrowLock's hold-capture but pays the seller
 * directly instead of routing through the ESCROW account.
 */
export async function settleDirectSale(
  params: { buyerAccountId: string; sellerAccountId: string; amount: Micros; orderId: string; auctionId: string | null },
  prisma: PrismaClient = defaultPrisma,
): Promise<void> {
  assertPositive(params.amount);
  const key = `direct-sale:${params.orderId}`;
  if (await alreadyApplied(key, prisma)) return;
  try {
    await prisma.$transaction(async (tx) => {
      await lockAccount(tx, params.buyerAccountId);
      if (params.auctionId !== null) {
        // Auction win: capture the winner's hold so their funds are actually
        // spent (not just reserved) — the hold itself covered this amount.
        await tx.hold.updateMany({
          where: {
            auctionId: params.auctionId,
            accountId: params.buyerAccountId,
            status: HoldStatus.ACTIVE,
          },
          data: { status: HoldStatus.CAPTURED, releasedAt: new Date() },
        });
        const settled = await getSettledBalance(params.buyerAccountId, tx);
        if (settled < params.amount) {
          throw new InsufficientFundsError(params.buyerAccountId, settled, params.amount);
        }
      } else {
        // Store purchase (no auction → no hold to capture): pay from AVAILABLE
        // balance only — funds reserved under live bids stay untouchable, or a
        // buyer could spend the same dollars twice.
        const available = await getAvailableBalance(params.buyerAccountId, tx);
        if (available < params.amount) {
          throw new InsufficientFundsError(params.buyerAccountId, available, params.amount);
        }
      }
      await postEntries(tx, [
        {
          accountId: params.buyerAccountId,
          amount: -params.amount,
          type: LedgerType.PURCHASE_DEBIT,
          refType: LedgerRefType.ORDER,
          refId: params.orderId,
          idempotencyKey: key,
        },
        {
          accountId: params.sellerAccountId,
          amount: params.amount,
          type: LedgerType.PAYOUT_CREDIT,
          refType: LedgerRefType.ORDER,
          refId: params.orderId,
        },
      ]);
    }, TX_OPTS);
  } catch (err) {
    if (isUniqueViolation(err)) return;
    throw err;
  }
}

/**
 * Charge a buyer for a shipment. The platform runs shipping (buys the carrier
 * label), so the WHOLE fee — base shipping plus any privacy premium — goes to the
 * operator FEE pool; the seller is paid nothing here. Paid from AVAILABLE balance
 * (funds locked in active bids stay put). Idempotent per shipment. Both legs sum
 * to zero. Reuses existing ledger types to stay out of the enum drift test.
 */
export async function settleShipping(
  params: {
    buyerAccountId: string;
    /** Total the buyer pays (base shipping + any privacy premium) → FEE pool. */
    amount: Micros;
    shipmentId: string;
  },
  prisma: PrismaClient = defaultPrisma,
): Promise<void> {
  assertPositive(params.amount);
  const key = `shipping:${params.shipmentId}`;
  if (await alreadyApplied(key, prisma)) return;
  try {
    await prisma.$transaction(async (tx) => {
      await lockAccount(tx, params.buyerAccountId);
      const available = await availableWithinTx(tx, params.buyerAccountId);
      if (available < params.amount) {
        throw new InsufficientFundsError(params.buyerAccountId, available, params.amount);
      }
      await postEntries(tx, [
        {
          accountId: params.buyerAccountId,
          amount: -params.amount,
          type: LedgerType.PURCHASE_DEBIT,
          refType: LedgerRefType.TRANSFER,
          refId: params.shipmentId,
          idempotencyKey: key,
        },
        {
          accountId: SYSTEM_ACCOUNT_IDS.FEE,
          amount: params.amount,
          type: LedgerType.PLATFORM_FEE,
          refType: LedgerRefType.TRANSFER,
          refId: params.shipmentId,
        },
      ]);
      // Physically segregate the shipping USDC into the fee wallet (no-op when the
      // fee wallet falls back to treasury, i.e. before escrow mode is configured).
      await enqueueChainLegs(tx, [
        { key, fromWallet: 'treasury', toWallet: 'fee', amount: params.amount, memo: key },
      ]);
    }, TX_OPTS);
  } catch (err) {
    if (isUniqueViolation(err)) return;
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Escrow ledger primitives (used by DevWalletEscrow)
// ---------------------------------------------------------------------------

/**
 * Lock a winner's funds into escrow: capture their ACTIVE hold and move the
 * amount buyer -> ESCROW. NO fee is taken here — the 5% is only charged on
 * release, so a refund can return 100%. Idempotent per order.
 */
export async function escrowLock(
  params: { buyerAccountId: string; amount: Micros; orderId: string; auctionId: string | null; chainLegs?: ChainLeg[] },
  prisma: PrismaClient = defaultPrisma,
): Promise<void> {
  assertPositive(params.amount);
  const key = `escrow-lock:${params.orderId}`;
  if (await alreadyApplied(key, prisma)) return;
  try {
    await prisma.$transaction(async (tx) => {
      await lockAccount(tx, params.buyerAccountId);
      if (params.auctionId !== null) {
        // Auction win: the winner's hold covers the amount — capture it.
        await tx.hold.updateMany({
          where: {
            auctionId: params.auctionId,
            accountId: params.buyerAccountId,
            status: HoldStatus.ACTIVE,
          },
          data: { status: HoldStatus.CAPTURED, releasedAt: new Date() },
        });
        const settled = await getSettledBalance(params.buyerAccountId, tx);
        if (settled < params.amount) {
          throw new InsufficientFundsError(params.buyerAccountId, settled, params.amount);
        }
      } else {
        // Store purchase (no hold): AVAILABLE balance only — live-bid holds
        // stay untouchable so the same dollars can't be spent twice.
        const available = await getAvailableBalance(params.buyerAccountId, tx);
        if (available < params.amount) {
          throw new InsufficientFundsError(params.buyerAccountId, available, params.amount);
        }
      }
      await postEntries(tx, [
        {
          accountId: params.buyerAccountId,
          amount: -params.amount,
          type: LedgerType.ESCROW_LOCK,
          refType: LedgerRefType.ORDER,
          refId: params.orderId,
          idempotencyKey: key,
        },
        {
          accountId: SYSTEM_ACCOUNT_IDS.ESCROW,
          amount: params.amount,
          type: LedgerType.ESCROW_LOCK,
          refType: LedgerRefType.ORDER,
          refId: params.orderId,
        },
      ]);
      await enqueueChainLegs(tx, params.chainLegs);
    }, TX_OPTS);
  } catch (err) {
    if (isUniqueViolation(err)) return;
    throw err;
  }
}

/**
 * Release escrow, splitting the sale 95 / 4 / 1:
 *   ESCROW -> 95% seller (PAYOUT_CREDIT)
 *          -> 4%  buyback pool  = PLATFORM account (PLATFORM_FEE)
 *          -> 1%  operator fee  = FEE account      (PLATFORM_FEE)
 * All four legs sum to zero. Idempotent per order.
 */
/** The ONE idempotency key for an order's terminal escrow move. Release and refund
 *  are mutually-exclusive outcomes, so they SHARE this key: the ledger's unique
 *  constraint then guarantees at most one of them ever posts for a given order —
 *  a disputed order racing the auto-release timer can never drain escrow twice. */
export const escrowSettleKey = (orderId: string) => `escrow-settle:${orderId}`;

/** Whether an order's terminal escrow move (release OR refund) has already posted.
 *  Used by the order-timer crash-recovery pass to finish a half-applied settle. */
export async function escrowSettleApplied(orderId: string, reader: Reader = defaultPrisma): Promise<boolean> {
  return alreadyApplied(escrowSettleKey(orderId), reader);
}

/** Whether an order's escrow LOCK posted — i.e. its funds actually entered escrow.
 *  Direct-payout orders never lock, so this lets recovery skip them (re-releasing a
 *  direct order would post an escrow move against funds that were never escrowed). */
export async function escrowLockApplied(orderId: string, reader: Reader = defaultPrisma): Promise<boolean> {
  return alreadyApplied(`escrow-lock:${orderId}`, reader);
}

export async function escrowRelease(
  params: { sellerAccountId: string; amount: Micros; orderId: string; chainLegs?: ChainLeg[] },
  prisma: PrismaClient = defaultPrisma,
): Promise<{ sellerProceeds: bigint; buybackFee: bigint; platformFee: bigint }> {
  assertPositive(params.amount);
  const { sellerProceeds, buybackFee, platformFee } = splitSale(params.amount);
  const key = escrowSettleKey(params.orderId);
  if (!(await alreadyApplied(key, prisma))) {
    try {
      await prisma.$transaction(async (tx) => {
        await postEntries(tx, [
          {
            accountId: SYSTEM_ACCOUNT_IDS.ESCROW,
            amount: -params.amount,
            type: LedgerType.ESCROW_RELEASE,
            refType: LedgerRefType.ORDER,
            refId: params.orderId,
            idempotencyKey: key,
          },
          {
            accountId: params.sellerAccountId,
            amount: sellerProceeds,
            type: LedgerType.PAYOUT_CREDIT,
            refType: LedgerRefType.ORDER,
            refId: params.orderId,
          },
          {
            accountId: SYSTEM_ACCOUNT_IDS.PLATFORM, // buyback pool (4%)
            amount: buybackFee,
            type: LedgerType.PLATFORM_FEE,
            refType: LedgerRefType.ORDER,
            refId: params.orderId,
          },
          {
            accountId: SYSTEM_ACCOUNT_IDS.FEE, // operator fee pool (1%)
            amount: platformFee,
            type: LedgerType.PLATFORM_FEE,
            refType: LedgerRefType.ORDER,
            refId: params.orderId,
          },
        ]);
        await enqueueChainLegs(tx, params.chainLegs);
      }, TX_OPTS);
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
    }
  }
  return { sellerProceeds, buybackFee, platformFee };
}

/** Refund escrow: ESCROW -> 100% buyer (REFUND). No fee — never taken. */
export async function escrowRefund(
  params: { buyerAccountId: string; amount: Micros; orderId: string; chainLegs?: ChainLeg[] },
  prisma: PrismaClient = defaultPrisma,
): Promise<void> {
  assertPositive(params.amount);
  const key = escrowSettleKey(params.orderId); // SHARED with release — release XOR refund
  if (await alreadyApplied(key, prisma)) return;
  try {
    await prisma.$transaction(async (tx) => {
      await postEntries(tx, [
        {
          accountId: SYSTEM_ACCOUNT_IDS.ESCROW,
          amount: -params.amount,
          type: LedgerType.ESCROW_RELEASE,
          refType: LedgerRefType.ORDER,
          refId: params.orderId,
          idempotencyKey: key,
        },
        {
          accountId: params.buyerAccountId,
          amount: params.amount,
          type: LedgerType.REFUND,
          refType: LedgerRefType.ORDER,
          refId: params.orderId,
        },
      ]);
      await enqueueChainLegs(tx, params.chainLegs);
    }, TX_OPTS);
  } catch (err) {
    if (isUniqueViolation(err)) return;
    throw err;
  }
}

/** The buyback-pending pool: fees collected on the PLATFORM account, awaiting a $BID buyback. */
export async function getBuybackPending(reader: Reader = defaultPrisma): Promise<bigint> {
  return getSettledBalance(SYSTEM_ACCOUNT_IDS.PLATFORM, reader);
}

/**
 * Record that the platform spent `amountMicros` from the buyback pool to buy $BID.
 * The USDC leaves the system (PLATFORM -> EXTERNAL); the $BID acquired is a
 * different asset, not tracked in this USDC ledger. Idempotent per tx signature.
 */
export async function recordBuybackSpend(
  amountMicros: Micros,
  txSig: string,
  prisma: PrismaClient = defaultPrisma,
): Promise<void> {
  assertPositive(amountMicros);
  const key = `buyback:${txSig}`;
  if (await alreadyApplied(key, prisma)) return;
  try {
    await prisma.$transaction(async (tx) => {
      await postEntries(tx, [
        {
          accountId: SYSTEM_ACCOUNT_IDS.PLATFORM,
          amount: -amountMicros,
          type: LedgerType.WITHDRAWAL,
          refType: LedgerRefType.ADJUSTMENT,
          refId: txSig,
          idempotencyKey: key,
        },
        {
          accountId: SYSTEM_ACCOUNT_IDS.EXTERNAL,
          amount: amountMicros,
          type: LedgerType.WITHDRAWAL,
          refType: LedgerRefType.ADJUSTMENT,
          refId: txSig,
        },
      ]);
    }, TX_OPTS);
  } catch (err) {
    if (isUniqueViolation(err)) return;
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Account helpers
// ---------------------------------------------------------------------------

/** Get (or lazily create) the single USER account for a user id. */
export async function getOrCreateUserAccount(
  userId: string,
  prisma: PrismaClient = defaultPrisma,
): Promise<string> {
  const existing = await prisma.account.findUnique({ where: { userId } });
  if (existing) return existing.id;
  try {
    const created = await prisma.account.create({
      data: { userId, kind: AccountKind.USER },
    });
    return created.id;
  } catch (err) {
    if (isUniqueViolation(err)) {
      const account = await prisma.account.findUnique({ where: { userId } });
      if (account) return account.id;
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

async function availableWithinTx(tx: Tx, accountId: string): Promise<bigint> {
  const settled = await getSettledBalance(accountId, tx);
  const holds = await getActiveHolds(accountId, tx);
  return settled - holds;
}

function assertPositive(amount: bigint): void {
  if (typeof amount !== 'bigint') {
    throw new InvalidAmountError('Amount must be a bigint of micro-units');
  }
  if (amount <= 0n) {
    throw new InvalidAmountError(`Amount must be positive, got ${amount}`);
  }
}

async function alreadyApplied(key: string, reader: Reader): Promise<boolean> {
  const entry = await reader.ledgerEntry.findUnique({ where: { idempotencyKey: key } });
  return entry !== null;
}

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: string }).code === 'P2002'
  );
}
