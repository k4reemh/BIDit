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

  /** One poll. Returns the number of deposits credited. Never throws — a failed
   *  poll is logged and retried next tick, so the watcher (and the whole server)
   *  can't be taken down by a transient chain/RPC error. */
  async tick(): Promise<number> {
    try {
      const { events, cursor } = await this.chain.pollDeposits(this.cursor);
      this.cursor = cursor;
      let credited = 0;
      for (const event of events) {
        try {
          const accountId = await getOrCreateUserAccount(event.userId, this.prisma);
          await deposit(
            {
              accountId,
              amount: event.amountMicros,
              refId: event.txSig,
              idempotencyKey: `chain-deposit:${event.txSig}`,
            },
            this.prisma,
          );
          credited += 1;
          try {
            this.onCredit?.(event.userId);
          } catch {
            /* a notify failure must never break crediting */
          }
        } catch (err) {
          console.error('[deposit-watcher] credit failed for', event.txSig, (err as Error)?.message ?? err);
        }
      }
      return credited;
    } catch (err) {
      console.error('[deposit-watcher] poll failed (will retry):', (err as Error)?.message ?? err);
      return 0;
    }
  }
}
