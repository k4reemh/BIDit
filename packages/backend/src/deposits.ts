/**
 * Deposit rail: hand each user a deposit address, watch the chain for inbound
 * transfers, and credit the ledger (idempotent on the tx signature).
 *
 * Two assets land on the same address:
 *  - USDC (SPL): credited 1:1, unchanged from Chunk 1.
 *  - native SOL: swept like USDC, then converted to a USDC-denominated credit at
 *    the oracle price (prices.ts) minus a spread. The receipt stores the full
 *    conversion audit (lamports, price, spread, source). If no trustworthy price
 *    exists the receipt simply stays unpriced and is retried next tick: a SOL
 *    deposit can be delayed, never lost and never mispriced.
 */
import { formatUsdc } from '@bidit/shared';
import { prisma as defaultPrisma } from './db.js';
import type { PrismaClient } from './db.js';
import { deposit, getOrCreateUserAccount } from './ledger.js';
import type { ChainClient } from './chain/index.js';
import { deriveDepositAddress } from './wallet.js';
import { getSolUsdPrice, lamportsToUsdcMicros, solSpreadBps, type SolPrice } from './prices.js';
import { notify } from './notifications.js';

/** Kill switch: SOL deposits are on unless BIDIT_SOL_DEPOSITS=no. */
export function solDepositsEnabled(): boolean {
  return process.env.BIDIT_SOL_DEPOSITS !== 'no';
}

/** Below this, SOL at a deposit address is dust: not worth a sweep fee. It stays
 *  put and counts toward the user's next deposit. Default 0.001 SOL. */
export function minSolLamports(): bigint {
  const raw = Number(process.env.BIDIT_SOL_MIN_LAMPORTS ?? 1_000_000);
  if (!Number.isFinite(raw) || raw < 0) return 1_000_000n;
  return BigInt(Math.floor(raw));
}

/** "2000000000 lamports" → "2", "1503000000" → "1.503" (≤4dp, trimmed). */
export function formatSol(lamports: bigint): string {
  const whole = lamports / 1_000_000_000n;
  const frac = ((lamports % 1_000_000_000n) / 100_000n).toString().padStart(4, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : String(whole);
}

/**
 * Ensure the user has a persisted deposit address; returns it. Addresses are
 * derived from the operator master seed (see wallet.ts): a real Solana address
 * with no stored private key. Legacy `mock…` addresses are upgraded in place.
 */
export async function ensureDepositAddress(
  userId: string,
  chain: ChainClient,
  prisma: PrismaClient = defaultPrisma,
): Promise<string> {
  const accountId = await getOrCreateUserAccount(userId, prisma);
  const account = await prisma.account.findUniqueOrThrow({ where: { id: accountId } });
  // Register the user with the chain so pollDeposits watches (and sweeps) their
  // address. SolanaChain derives the SAME address from wallet.ts, so what we show
  // is what we watch. Safe/no-op for the mock chain.
  await chain.depositAddress(userId).catch(() => {});
  if (account.depositAddress && !account.depositAddress.startsWith('mock')) return account.depositAddress;
  const address = deriveDepositAddress(userId);
  await prisma.account.update({ where: { id: accountId }, data: { depositAddress: address } });
  return address;
}

/**
 * Register every existing user with the chain so their deposits are watched even
 * before they next load the app (deposit polling survives a restart). Call once
 * on startup.
 */
export async function registerAllDeposits(
  chain: ChainClient,
  prisma: PrismaClient = defaultPrisma,
): Promise<number> {
  const accounts = await prisma.account.findMany({
    where: { userId: { not: null } },
    select: { userId: true },
  });
  let n = 0;
  for (const a of accounts) {
    if (!a.userId) continue;
    await chain.depositAddress(a.userId).catch(() => {});
    n += 1;
  }
  return n;
}

/**
 * Polls the chain for new inbound USDC and credits the ledger. Server-driven,
 * like the auction/order schedulers; tests call tick() directly.
 */
export class DepositWatcher {
  private cursor: string | null = null;
  /** Guards against overlapping polls: on a slow/rate-limited RPC a poll can run
   *  longer than the interval, and without this the next tick would fire on top of
   *  it and pile MORE RPC calls on: a 429 death-spiral. One watcher per process. */
  private running = false;

  constructor(
    private readonly chain: ChainClient,
    private readonly prisma: PrismaClient = defaultPrisma,
    private readonly intervalMs = 5000,
    /** Called with the userId after a deposit is credited, so the caller can push
     *  a live BALANCE_UPDATE (the account balance updates without a page refresh). */
    private readonly onCredit?: (userId: string) => void,
    /** Injectable for tests; production uses the guarded live oracle. */
    private readonly priceFn: () => Promise<SolPrice> = () => getSolUsdPrice(),
  ) {}

  /** Poll counter: on real chains SOL is polled every 2nd tick to halve the RPC
   *  spend (the Helius credit budget); the mock chain polls every tick so dev
   *  and tests stay synchronous. */
  private tickN = 0;

  private timer: ReturnType<typeof setInterval> | null = null;
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

  /** One poll. Detected+swept deposits are first written durably (DepositReceipt),
   *  THEN credited from those records, so a crash between the on-chain sweep and
   *  the ledger credit can never lose a user's money (the next tick / startup
   *  reconcile finishes it). Returns the number of receipts credited this tick.
   *  Never throws: a failed poll is logged and retried next tick. */
  async tick(): Promise<number> {
    if (this.running) return 0; // a previous poll is still in flight: don't stack
    this.running = true;
    try {
      const { events, cursor } = await this.chain.pollDeposits(this.cursor);
      this.cursor = cursor;
      // 1. Durably record every swept deposit BEFORE crediting (idempotent on txSig).
      for (const event of events) {
        try {
          await this.prisma.depositReceipt.upsert({
            where: { txSig: event.txSig },
            create: { userId: event.userId, amountMicros: event.amountMicros, txSig: event.txSig },
            update: {}, // already recorded, no-op
          });
        } catch (err) {
          console.error('[deposit-watcher] record failed for', event.txSig, (err as Error)?.message ?? err);
        }
      }
      // 1b. Native SOL: sweep + durably record, same shape as USDC. The receipt
      //     is written unpriced (amountMicros 0, priceUsdMicro null); pricing
      //     happens in creditPending so a dead oracle delays rather than loses.
      const solEvery = this.chain.cluster === 'mock' ? 1 : 2;
      if (solDepositsEnabled() && this.tickN++ % solEvery === 0) {
        try {
          const solEvents = await this.chain.pollSolDeposits(minSolLamports());
          for (const event of solEvents) {
            try {
              await this.prisma.depositReceipt.upsert({
                where: { txSig: event.txSig },
                create: {
                  userId: event.userId,
                  amountMicros: 0n,
                  txSig: event.txSig,
                  asset: 'SOL',
                  lamports: event.lamports,
                },
                update: {}, // already recorded, no-op
              });
            } catch (err) {
              console.error('[deposit-watcher] sol record failed for', event.txSig, (err as Error)?.message ?? err);
            }
          }
        } catch (err) {
          console.error('[deposit-watcher] sol poll failed (will retry):', (err as Error)?.message ?? err);
        }
      }
      // 2. Credit everything not yet credited (this poll's + any orphaned by a
      //    prior crash). The ledger credit is idempotent, so retries are safe.
      return await this.creditPending();
    } catch (err) {
      console.error('[deposit-watcher] poll failed (will retry):', (err as Error)?.message ?? err);
      return 0;
    } finally {
      this.running = false;
    }
  }

  /**
   * Credit every recorded-but-uncredited deposit. Idempotent: the ledger credit
   * is keyed on the tx signature, and `creditedAt` is flipped only after it lands,
   * so a crash anywhere in here just leaves the row to be retried, never a double
   * credit. Called each tick and once on startup (reconcile) to recover orphans.
   */
  async creditPending(): Promise<number> {
    const pending = await this.prisma.depositReceipt.findMany({
      where: { creditedAt: null },
      orderBy: { sweptAt: 'asc' },
      take: 500,
    });
    // One oracle call per pass, and only when an unpriced SOL receipt needs it.
    // A failed fetch skips those rows this pass (they retry next tick); USDC
    // rows are never blocked by the oracle.
    let price: SolPrice | null = null;
    if (pending.some((r) => r.asset === 'SOL' && r.priceUsdMicro === null)) {
      try {
        price = await this.priceFn();
      } catch (err) {
        console.warn('[deposit-watcher] no sol price yet, sol credits wait:', (err as Error)?.message ?? err);
      }
    }
    let credited = 0;
    for (const r of pending) {
      try {
        if (r.asset === 'SOL' && r.priceUsdMicro === null) {
          if (!price) continue; // no trustworthy price: try again next tick
          const spread = solSpreadBps();
          const amount = lamportsToUsdcMicros(r.lamports ?? 0n, price.usdMicro, spread);
          await this.prisma.depositReceipt.update({
            where: { id: r.id },
            data: { amountMicros: amount, priceUsdMicro: price.usdMicro, spreadBps: Number(spread), priceSource: price.source },
          });
          r.amountMicros = amount;
          r.priceUsdMicro = price.usdMicro;
        }
        if (r.amountMicros <= 0n) {
          // Dust that rounds to $0: nothing to credit, close the receipt.
          await this.prisma.depositReceipt.update({ where: { id: r.id }, data: { creditedAt: new Date() } });
          continue;
        }
        const accountId = await getOrCreateUserAccount(r.userId, this.prisma);
        await deposit(
          {
            accountId,
            amount: r.amountMicros,
            refId: r.txSig,
            idempotencyKey: `chain-deposit:${r.txSig}`,
          },
          this.prisma,
        );
        await this.prisma.depositReceipt.update({ where: { id: r.id }, data: { creditedAt: new Date() } });
        credited += 1;
        if (r.asset === 'SOL') {
          // The conversion deserves a durable record the user can see: what
          // arrived, what it became, at what price. USDC stays balance-push only.
          const perSol = formatUsdc(r.priceUsdMicro ?? 0n);
          await notify(
            {
              userId: r.userId,
              kind: 'deposit',
              title: `Deposited ${formatSol(r.lamports ?? 0n)} SOL → $${formatUsdc(r.amountMicros)}`,
              body: `Converted at $${perSol} per SOL (includes the ${Number(solSpreadBps()) / 100}% conversion fee). It's in your balance and ready to bid.`,
              href: '/account/deposit',
            },
            this.prisma,
          ).catch(() => {});
        }
        try {
          this.onCredit?.(r.userId);
        } catch {
          /* a notify failure must never break crediting */
        }
      } catch (err) {
        console.error('[deposit-watcher] credit failed for', r.txSig, (err as Error)?.message ?? err);
      }
    }
    return credited;
  }

  /** Startup recovery: finish crediting any deposit swept before a prior crash. */
  reconcile(): Promise<number> {
    return this.creditPending();
  }
}
