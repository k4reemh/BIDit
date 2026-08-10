/**
 * Treasury SOL → USDC auto-swap worker.
 *
 * Native SOL deposits are swept into treasury (deposits.ts) and the depositor is
 * credited USDC at the oracle price minus a spread. That leaves treasury holding
 * SOL against a USDC liability. This worker periodically converts the excess SOL
 * to USDC (via chain.swapSolToUsdc → Jupiter on mainnet), so:
 *   - treasury USDC keeps backing user USDC balances (the audit stays balanced),
 *   - the ~1.5% deposit spread is realized as USDC, not left exposed to SOL price,
 *   - withdrawals always pay USDC and never touch SOL.
 *
 * It keeps a SOL reserve so treasury can still pay transaction fees (deposit
 * sweeps, withdrawal ATA rent). No ledger entry is posted: the ledger already
 * credited the user in USDC when the SOL arrived; this only converts the physical
 * asset. Every swap is recorded (TreasurySwap) for the books.
 *
 * Enabled with BIDIT_AUTO_SWAP=yes (default off — it trades real funds). On the
 * mock chain it can run in dev to exercise the loop end to end.
 */
import { prisma as defaultPrisma } from './db.js';
import type { PrismaClient } from './db.js';
import type { ChainClient } from './chain/index.js';

/** Keep this much SOL in treasury for fees (sweeps, withdrawal rent). Default 0.3 SOL. */
export function treasurySolReserveLamports(): bigint {
  const raw = Number(process.env.BIDIT_TREASURY_SOL_RESERVE_LAMPORTS ?? 300_000_000);
  if (!Number.isFinite(raw) || raw < 0) return 300_000_000n;
  return BigInt(Math.floor(raw));
}

/** Don't swap dust: only convert when the swappable excess is at least this
 *  much SOL (a swap costs a fee + slippage). Default 0.05 SOL. */
export function minSwapLamports(): bigint {
  const raw = Number(process.env.BIDIT_MIN_SWAP_LAMPORTS ?? 50_000_000);
  if (!Number.isFinite(raw) || raw <= 0) return 50_000_000n;
  return BigInt(Math.floor(raw));
}

/** True unless BIDIT_AUTO_SWAP is explicitly off. Callers gate on this AND the
 *  flag being set: see shouldRun. */
export function autoSwapEnabled(): boolean {
  return process.env.BIDIT_AUTO_SWAP === 'yes';
}

export class TreasurySwapWorker {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(
    private readonly chain: ChainClient,
    private readonly prisma: PrismaClient = defaultPrisma,
    private readonly intervalMs = 60_000,
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

  /**
   * One pass: convert treasury SOL above the reserve into USDC. Returns the USDC
   * micro-units realized this tick (0 if nothing to do). Never throws: a failed
   * swap (no route, RPC blip, slippage) is logged and retried next tick, leaving
   * the SOL safely in treasury.
   */
  async tick(): Promise<bigint> {
    if (this.running) return 0n;
    this.running = true;
    try {
      const reserve = treasurySolReserveLamports();
      const balance = await this.chain.solBalanceLamports('treasury');
      const excess = balance - reserve;
      if (excess < minSwapLamports()) return 0n; // nothing worth swapping

      const result = await this.chain.swapSolToUsdc(excess);
      // Record the swap idempotently (txSig unique). A crash after the on-chain
      // swap but before this insert just leaves an unrecorded swap — the funds
      // are already USDC in treasury, so nothing is lost, only under-logged.
      await this.prisma.treasurySwap
        .create({
          data: { lamportsIn: result.lamportsIn, usdcMicrosOut: result.usdcMicrosOut, txSig: result.txSig },
        })
        .catch((err: unknown) => {
          // Unique-violation on resume is fine; anything else is worth a log.
          const msg = (err as Error)?.message ?? String(err);
          if (!/unique|P2002/i.test(msg)) console.error('[auto-swap] record failed for', result.txSig, msg);
        });
      console.log(
        `[auto-swap] swapped ${result.lamportsIn} lamports → ${result.usdcMicrosOut} USDC micro (${result.txSig})`,
      );
      return result.usdcMicrosOut;
    } catch (err) {
      console.error('[auto-swap] swap failed (will retry):', (err as Error)?.message ?? err);
      return 0n;
    } finally {
      this.running = false;
    }
  }
}

/** Sum of USDC realized from SOL auto-swaps (for /admin/stats). */
export async function totalAutoSwappedUsdcMicros(prisma: PrismaClient = defaultPrisma): Promise<bigint> {
  const agg = await prisma.treasurySwap.aggregate({ _sum: { usdcMicrosOut: true } });
  return agg._sum.usdcMicrosOut ?? 0n;
}
