/**
 * Withdrawal rail — durable settlement state machine.
 *
 * Moving USDC out crosses two systems that cannot commit together: the ledger
 * (Postgres) and the chain (Solana). The naive "debit, send, and reverse the
 * debit if send throws" is unsafe: a send can *time out ambiguously* — the
 * transaction actually lands on-chain but the ack is lost — and blindly reversing
 * then hands the user their USDC AND their balance back (a double-spend that
 * drains the treasury).
 *
 * This module removes that trap. The debit is posted once, up front, and the row
 * tracks the transfer's fate:
 *
 *   PENDING → (debit) → SUBMITTED → (chain confirms)      → CONFIRMED   [terminal]
 *                                 → (chain proves it dead) → FAILED      [terminal, debit reversed]
 *                                 → (long outage)          → NEEDS_REVIEW[debit retained, operator]
 *
 * The debit is reversed ONLY when the chain positively reports the transfer is
 * dead — the tx erred on-chain, or its blockhash expired without it landing (see
 * ChainClient.getTransferStatus). An ambiguous / still-in-flight send is NEVER
 * reversed; it is left SUBMITTED for the reconciler, which re-checks until the
 * chain gives a definite answer. Reversal is idempotent (ledger idempotency key +
 * reversedAt guard) so it can never fire twice.
 *
 * Beta safety: a temporary per-user rolling-24h cap (default $1,000, override with
 * BIDIT_WITHDRAW_DAILY_CAP_USD) bounds the blast radius while the payout path is
 * still being hardened.
 */
import { LedgerType, LedgerRefType, usdc, formatUsdc, type Micros } from '@bidit/shared';
import type { Withdrawal } from '@prisma/client';
import { prisma as defaultPrisma } from './db.js';
import type { PrismaClient } from './db.js';
import { debit, credit, getOrCreateUserAccount } from './ledger.js';
import type { ChainClient } from './chain/index.js';

const DAY_MS = 24 * 60 * 60 * 1000;
/** Statuses that represent money that is out or may still be out — everything
 *  except FAILED (which has been reversed). Used for the cap and for reconcile. */
const INFLIGHT = ['PENDING', 'SUBMITTED', 'CONFIRMED', 'NEEDS_REVIEW'] as const;
/** Statuses still awaiting a definite on-chain answer. */
const UNSETTLED = ['SUBMITTED', 'NEEDS_REVIEW'] as const;
/** Inline (request-time) settle attempts, so a fast confirm returns CONFIRMED
 *  rather than SUBMITTED. Anything slower is finalized by the reconciler. */
const INLINE_SETTLE_ATTEMPTS = 3;
const INLINE_SETTLE_DELAY_MS = 400;
/** A SUBMITTED row still unresolved after this long (a persistent RPC outage) is
 *  flagged NEEDS_REVIEW for an operator. The debit stays put; reconcile keeps
 *  trying, so it self-heals once the chain is reachable again. */
const STUCK_MS = 30 * 60 * 1000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const errMsg = (err: unknown) => (err as Error)?.message ?? String(err);

/** A user-facing withdrawal rejection (bad address, over the daily cap). */
export class WithdrawalError extends Error {
  readonly status = 400;
  constructor(message: string) {
    super(message);
    this.name = 'WithdrawalError';
  }
}

/** Temporary beta cap: max USDC a single user may withdraw per rolling 24h. */
export function dailyWithdrawCapMicros(): bigint {
  const raw = process.env.BIDIT_WITHDRAW_DAILY_CAP_USD;
  if (raw != null && raw.trim() !== '') {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return usdc(String(n));
  }
  return usdc('1000');
}

/** USDC a user has committed to withdrawing in the last 24h. Counts everything
 *  in-flight or confirmed; only FAILED (reversed) rows are excluded — so a stuck
 *  or ambiguous withdrawal keeps consuming the cap until it is proven dead. */
export async function withdrawnLast24h(userId: string, prisma: PrismaClient = defaultPrisma): Promise<bigint> {
  const agg = await prisma.withdrawal.aggregate({
    where: { userId, createdAt: { gte: new Date(Date.now() - DAY_MS) }, status: { in: [...INFLIGHT] } },
    _sum: { amount: true },
  });
  return agg._sum.amount ?? 0n;
}

export async function requestWithdrawal(
  userId: string,
  toAddress: string,
  amountMicros: Micros,
  chain: ChainClient,
  prisma: PrismaClient = defaultPrisma,
): Promise<Withdrawal> {
  // 1. Destination must be a valid on-chain address — before any ledger movement.
  if (!chain.isValidAddress(toAddress)) {
    throw new WithdrawalError('That doesn’t look like a valid Solana address.');
  }

  // 1b. The destination must be EXTERNAL. Withdrawing into an operator wallet is an
  //     on-chain self-transfer (no funds leave) while the ledger still debits the
  //     user — silently corrupting the treasury↔Σbalances reconciliation. Withdrawing
  //     into a user deposit address would round-trip back through the deposit sweep.
  //     Both are internal addresses and never valid withdrawal targets.
  const operatorWallets = (['treasury', 'escrow', 'buyback', 'fee'] as const).map((w) => chain.walletAddress(w));
  const isDepositAddress = await prisma.account.findFirst({ where: { depositAddress: toAddress }, select: { id: true } });
  if (operatorWallets.includes(toAddress) || isDepositAddress) {
    throw new WithdrawalError('That address isn’t a valid withdrawal destination.');
  }

  // 2. Temporary beta daily cap. Checked before debiting so an over-cap request
  //    never moves money. (Not a hard concurrency guard — acceptable for beta,
  //    where the cap is a blast-radius limit, not a security boundary.)
  const cap = dailyWithdrawCapMicros();
  const used = await withdrawnLast24h(userId, prisma);
  if (used + amountMicros > cap) {
    const remaining = used >= cap ? 0n : cap - used;
    const money = (m: bigint) => Number(formatUsdc(m)).toLocaleString('en-US', { maximumFractionDigits: 2 });
    throw new WithdrawalError(
      `Beta withdrawals are limited to $${money(cap)} per day. You have $${money(remaining)} left in the next 24h.`,
    );
  }

  const accountId = await getOrCreateUserAccount(userId, prisma);
  const withdrawal = await prisma.withdrawal.create({
    data: { userId, toAddress, amount: amountMicros, status: 'PENDING' },
  });

  // 3. Debit first (this enforces the no-overspend / holds-respected guarantee).
  //    Throws InsufficientFundsError if available < amount. Nothing was sent and
  //    the debit never posted, so there is nothing to reverse — just mark FAILED.
  try {
    await debit(
      {
        accountId,
        amount: amountMicros,
        type: LedgerType.WITHDRAWAL,
        refType: LedgerRefType.WITHDRAWAL,
        refId: withdrawal.id,
        idempotencyKey: `withdraw:${withdrawal.id}`,
      },
      prisma,
    );
  } catch (err) {
    await prisma.withdrawal.update({
      where: { id: withdrawal.id },
      data: { status: 'FAILED', lastError: `debit rejected: ${errMsg(err)}` },
    });
    throw err;
  }

  // 4. Broadcast. sendTransfer throws ONLY before the tx is broadcast (blockhash /
  //    build / sign), so on a throw the funds definitively did not move → reverse.
  let sig: string;
  let lastValidBlockHeight: bigint | null;
  try {
    ({ sig, lastValidBlockHeight } = await chain.sendTransfer('treasury', toAddress, amountMicros, `withdraw:${withdrawal.id}`));
  } catch (err) {
    return reverseWithdrawal(withdrawal, accountId, `pre-broadcast send failure: ${errMsg(err)}`, prisma);
  }

  // 5. Broadcast succeeded (or timed out with a known signature) → SUBMITTED. From
  //    here the tx may land; we never reverse on an ambiguous/unknown status.
  const submitted = await prisma.withdrawal.update({
    where: { id: withdrawal.id },
    data: { status: 'SUBMITTED', txSig: sig, lastValidBlockHeight },
  });

  // 6. Best-effort inline settle so a quick confirm returns CONFIRMED; otherwise
  //    the row stays SUBMITTED and the reconciler finalizes it out of band.
  return settleWithdrawal(submitted, chain, accountId, prisma, INLINE_SETTLE_ATTEMPTS);
}

/**
 * Resolve a SUBMITTED/NEEDS_REVIEW withdrawal against the chain, at most `attempts`
 * times (sleeping between). Transitions to CONFIRMED or (reversing the debit once)
 * FAILED as soon as the chain is definite; returns the row unchanged while the
 * status is still 'unknown'. Safe to call repeatedly and concurrently.
 */
export async function settleWithdrawal(
  withdrawal: Withdrawal,
  chain: ChainClient,
  accountId: string,
  prisma: PrismaClient = defaultPrisma,
  attempts = 1,
): Promise<Withdrawal> {
  let current = withdrawal;
  for (let i = 0; i < attempts; i++) {
    if (!(UNSETTLED as readonly string[]).includes(current.status) || !current.txSig) return current;
    const fate = await chain.getTransferStatus(current.txSig, current.lastValidBlockHeight);
    if (fate === 'confirmed') {
      // Guard against racing a reversal: only a non-reversed row becomes CONFIRMED.
      const res = await prisma.withdrawal.updateMany({
        where: { id: current.id, status: { in: [...UNSETTLED] }, reversedAt: null },
        data: { status: 'CONFIRMED', lastError: null },
      });
      const fresh = await prisma.withdrawal.findUniqueOrThrow({ where: { id: current.id } });
      if (res.count === 0 && fresh.status !== 'CONFIRMED') return fresh; // lost a race to reversal
      return fresh;
    }
    if (fate === 'failed') {
      return reverseWithdrawal(current, accountId, 'chain reported transfer dead', prisma);
    }
    // 'unknown' — still in flight. Wait a beat and re-check (bounded).
    if (i < attempts - 1) await sleep(INLINE_SETTLE_DELAY_MS);
  }
  return current;
}

/**
 * Reverse a withdrawal's debit (credit the funds back) and mark it FAILED —
 * idempotently. Called ONLY when the transfer is proven dead (pre-broadcast throw,
 * or getTransferStatus === 'failed'). Credits BEFORE flipping status so a crash in
 * between just leaves the row for the reconciler to finish; the ledger idempotency
 * key + reversedAt guard make a double reversal impossible.
 */
async function reverseWithdrawal(
  withdrawal: Withdrawal,
  accountId: string,
  reason: string,
  prisma: PrismaClient = defaultPrisma,
): Promise<Withdrawal> {
  const fresh = await prisma.withdrawal.findUnique({ where: { id: withdrawal.id } });
  if (!fresh) return withdrawal;
  // Never reverse a transfer we've already confirmed landed, and never twice.
  if (fresh.status === 'CONFIRMED' || fresh.reversedAt) return fresh;
  await credit(
    {
      accountId,
      amount: fresh.amount,
      type: LedgerType.REFUND,
      refType: LedgerRefType.ADJUSTMENT,
      refId: fresh.id,
      idempotencyKey: `withdraw-reverse:${fresh.id}`,
    },
    prisma,
  );
  return prisma.withdrawal.update({
    where: { id: fresh.id },
    data: { status: 'FAILED', reversedAt: new Date(), lastError: reason },
  });
}

/**
 * Finalizes in-flight withdrawals against the chain — the durable half of the
 * state machine. Mirrors DepositWatcher: server-driven on an interval, and run
 * once on startup so any withdrawal that was mid-flight across a crash/restart is
 * resolved (confirmed, or reversed if the chain proves it never landed) instead of
 * hanging. Tests call tick() directly. Never throws.
 */
export class WithdrawalReconciler {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly chain: ChainClient,
    private readonly prisma: PrismaClient = defaultPrisma,
    private readonly intervalMs = 15_000,
    /** Called with the userId whenever a withdrawal reaches a terminal state, so
     *  the caller can push a live BALANCE_UPDATE (a reversal restores balance). */
    private readonly onSettle?: (userId: string) => void,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    this.timer.unref?.();
  }
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
  /** Startup recovery alias — resolve anything left in flight by a prior run. */
  reconcile(): Promise<number> {
    return this.tick();
  }

  /** One pass: check every unsettled withdrawal once. Returns how many reached a
   *  terminal state (CONFIRMED or FAILED) this pass. */
  async tick(): Promise<number> {
    let settled = 0;
    try {
      const rows = await this.prisma.withdrawal.findMany({
        where: { status: { in: [...UNSETTLED] }, txSig: { not: null } },
        orderBy: { createdAt: 'asc' },
        take: 200,
      });
      for (const row of rows) {
        try {
          const accountId = await getOrCreateUserAccount(row.userId, this.prisma);
          const after = await settleWithdrawal(row, this.chain, accountId, this.prisma, 1);
          if (after.status === 'CONFIRMED' || after.status === 'FAILED') {
            settled += 1;
            try {
              this.onSettle?.(row.userId);
            } catch {
              /* a notify failure must never break reconciliation */
            }
          } else if (
            after.status === 'SUBMITTED' &&
            Date.now() - after.createdAt.getTime() > STUCK_MS
          ) {
            // Persistently unresolved (RPC outage): surface it, keep the debit,
            // and keep retrying on later ticks (NEEDS_REVIEW stays in UNSETTLED).
            await this.prisma.withdrawal.update({
              where: { id: after.id },
              data: { status: 'NEEDS_REVIEW', lastError: 'unresolved on-chain status past review threshold' },
            });
            console.warn(`[withdraw-reconcile] ${after.id} needs review (unresolved > ${STUCK_MS}ms)`);
          }
        } catch (err) {
          console.error('[withdraw-reconcile] row failed for', row.id, errMsg(err));
        }
      }
    } catch (err) {
      console.error('[withdraw-reconcile] pass failed (will retry):', errMsg(err));
    }
    return settled;
  }
}
