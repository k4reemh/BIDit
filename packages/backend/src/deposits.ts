/**
 * Deposit rail: hand each user a USDC deposit address, watch the chain for
 * inbound transfers, and credit the ledger (idempotent on the tx signature).
 * The ledger is unchanged from Chunk 1 — it just now reflects real money in.
 */
import { prisma as defaultPrisma } from './db.js';
import type { PrismaClient } from './db.js';
import { deposit, getOrCreateUserAccount } from './ledger.js';
import type { ChainClient } from './chain/index.js';
import { deriveDepositAddress } from './wallet.js';

/**
 * Ensure the user has a persisted deposit address; returns it. Addresses are
 * derived from the operator master seed (see wallet.ts) — a real Solana address
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
   *  it and pile MORE RPC calls on — a 429 death-spiral. One watcher per process. */
  private running = false;

  constructor(
    private readonly chain: ChainClient,
    private readonly prisma: PrismaClient = defaultPrisma,
    private readonly intervalMs = 5000,
    /** Called with the userId after a deposit is credited, so the caller can push
     *  a live BALANCE_UPDATE (the account balance updates without a page refresh). */
    private readonly onCredit?: (userId: string) => void,
  ) {}

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
   *  THEN credited from those records — so a crash between the on-chain sweep and
   *  the ledger credit can never lose a user's money (the next tick / startup
   *  reconcile finishes it). Returns the number of receipts credited this tick.
   *  Never throws — a failed poll is logged and retried next tick. */
  async tick(): Promise<number> {
    if (this.running) return 0; // a previous poll is still in flight — don't stack
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
            update: {}, // already recorded — no-op
          });
        } catch (err) {
          console.error('[deposit-watcher] record failed for', event.txSig, (err as Error)?.message ?? err);
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
   * so a crash anywhere in here just leaves the row to be retried — never a double
   * credit. Called each tick and once on startup (reconcile) to recover orphans.
   */
  async creditPending(): Promise<number> {
    const pending = await this.prisma.depositReceipt.findMany({
      where: { creditedAt: null },
      orderBy: { sweptAt: 'asc' },
      take: 500,
    });
    let credited = 0;
    for (const r of pending) {
      try {
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
