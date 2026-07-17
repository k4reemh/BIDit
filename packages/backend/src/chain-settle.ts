/**
 * ChainSettler — drives the durable ChainTransfer outbox to the chain.
 *
 * Escrow/shipping ledger moves enqueue internal wallet→wallet legs (see
 * ledger.ts / escrow.ts), recorded atomically with the ledger write. This settler
 * broadcasts each leg and confirms it, mirroring DepositWatcher / WithdrawalReconciler:
 *
 *   PENDING → (sendTransfer) SUBMITTED → (getTransferStatus)
 *               confirmed → CONFIRMED
 *               failed    → PENDING (retry with a fresh blockhash)
 *               unknown   → wait
 *
 * Every wallet here is operator-controlled, so a failed/expired send simply gets
 * a fresh attempt — the funds never leave our control, so this can neither lose
 * money nor double-move it. A SUBMITTED leg is only ever *resolved*, never re-sent,
 * so an in-flight (unknown) tx is never duplicated. Legs whose ends resolve to the
 * same wallet (direct-mode fallback where escrow/fee/buyback default to treasury)
 * are a no-op and confirm immediately. Never throws.
 */
import { prisma as defaultPrisma } from './db.js';
import type { PrismaClient } from './db.js';
import type { ChainClient, WalletName } from './chain/index.js';

const WALLETS = new Set<WalletName>(['treasury', 'escrow', 'buyback', 'fee']);
const asWallet = (name: string): WalletName | null => (WALLETS.has(name as WalletName) ? (name as WalletName) : null);
const errMsg = (err: unknown) => (err as Error)?.message ?? String(err);

export class ChainSettler {
  private timer: ReturnType<typeof setInterval> | null = null;
  /** Guards against overlapping ticks broadcasting the same PENDING leg twice
   *  (two sends = two blockhashes = two real transfers = a double-move). One
   *  settler per process, so this fully serializes broadcasting. */
  private running = false;

  constructor(
    private readonly chain: ChainClient,
    private readonly prisma: PrismaClient = defaultPrisma,
    private readonly intervalMs = 8000,
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
  /** Startup recovery alias — finish anything left mid-flight by a prior run. */
  reconcile(): Promise<number> {
    return this.tick();
  }

  /** One pass. Returns how many legs reached CONFIRMED this pass. Never runs
   *  concurrently with itself (re-entrancy guard) so a leg is never double-sent. */
  async tick(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    let confirmed = 0;
    try {
      const rows = await this.prisma.chainTransfer.findMany({
        where: { status: { in: ['PENDING', 'SUBMITTED'] } },
        orderBy: { createdAt: 'asc' },
        take: 200,
      });
      for (const row of rows) {
        try {
          if (await this.process(row)) confirmed += 1;
        } catch (err) {
          console.error('[chain-settle] leg failed for', row.key, errMsg(err));
        }
      }
    } catch (err) {
      console.error('[chain-settle] pass failed (will retry):', errMsg(err));
    } finally {
      this.running = false;
    }
    return confirmed;
  }

  private async process(row: {
    id: string;
    status: string;
    fromWallet: string;
    toWallet: string;
    amount: bigint;
    memo: string | null;
    txSig: string | null;
    lastValidBlockHeight: bigint | null;
  }): Promise<boolean> {
    const from = asWallet(row.fromWallet);
    const to = asWallet(row.toWallet);
    if (!from || !to) {
      await this.prisma.chainTransfer.update({
        where: { id: row.id },
        data: { lastError: `unknown wallet ${row.fromWallet}→${row.toWallet}`, attempts: { increment: 1 } },
      });
      return false;
    }
    const toAddr = this.chain.walletAddress(to);

    let sig = row.txSig;
    let lvbh = row.lastValidBlockHeight;

    if (row.status === 'PENDING') {
      // Same wallet on both ends (fallback config) → nothing to move on-chain.
      if (this.chain.walletAddress(from) === toAddr) {
        await this.confirm(row.id);
        return true;
      }
      try {
        const r = await this.chain.sendTransfer(from, toAddr, row.amount, row.memo ?? undefined);
        sig = r.sig;
        lvbh = r.lastValidBlockHeight;
        await this.prisma.chainTransfer.update({
          where: { id: row.id },
          data: { status: 'SUBMITTED', txSig: sig, lastValidBlockHeight: lvbh, attempts: { increment: 1 }, lastError: null },
        });
      } catch (err) {
        // Pre-broadcast failure — nothing sent. Bump and retry next tick.
        await this.prisma.chainTransfer.update({
          where: { id: row.id },
          data: { attempts: { increment: 1 }, lastError: `send: ${errMsg(err)}` },
        });
        return false;
      }
    }

    if (!sig) return false; // SUBMITTED with no signature — wait for a later pass
    const fate = await this.chain.getTransferStatus(sig, lvbh);
    if (fate === 'confirmed') {
      await this.confirm(row.id);
      return true;
    }
    if (fate === 'failed') {
      // Internal move that never landed (expired / on-chain error) — safe to retry
      // from scratch with a fresh blockhash. Funds are still in our wallets.
      await this.prisma.chainTransfer.update({
        where: { id: row.id },
        data: { status: 'PENDING', txSig: null, lastValidBlockHeight: null, lastError: 'expired/failed; retrying' },
      });
      return false;
    }
    return false; // unknown — still in flight, resolve on a later pass
  }

  private confirm(id: string): Promise<unknown> {
    return this.prisma.chainTransfer.update({ where: { id }, data: { status: 'CONFIRMED', lastError: null } });
  }
}
