/**
 * The flywheel: the 5% platform-fee pool (PLATFORM ledger balance) is
 * periodically spent buying $BID on the open market and adding to LP, recorded
 * on-chain for public transparency.
 *
 * The actual swap is behind a Swapper interface: MockSwapper for tests, a real
 * DEX swap (Jupiter/Raydium) on mainnet later. On devnet there's no $BID/LP, so
 * the Solana swapper just reserves the USDC in the buyback wallet.
 */
import type { Buyback } from '@prisma/client';
import { prisma as defaultPrisma } from './db.js';
import type { PrismaClient } from './db.js';
import { getBuybackPending, recordBuybackSpend } from './ledger.js';

export interface Swapper {
  /** Spend `amountMicros` USDC from the buyback wallet on $BID. Returns a tx sig. */
  buyBid(amountMicros: bigint): Promise<string>;
}

/** Test/dev swapper — records the buy, no chain. */
export class MockSwapper implements Swapper {
  readonly swaps: bigint[] = [];
  async buyBid(amountMicros: bigint): Promise<string> {
    this.swaps.push(amountMicros);
    return `mockswap_${this.swaps.length}`;
  }
}

export class BuybackWorker {
  constructor(
    private readonly swapper: Swapper,
    private readonly prisma: PrismaClient = defaultPrisma,
    private readonly intervalMs = 60_000,
  ) {}

  private timer: ReturnType<typeof setInterval> | null = null;
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.run(), this.intervalMs);
    this.timer.unref?.();
  }
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Execute a buyback of the accrued pool if it clears `minMicros`. */
  async run(minMicros = 1n): Promise<Buyback | null> {
    const pending = await getBuybackPending(this.prisma);
    if (pending <= 0n || pending < minMicros) return null;
    const txSig = await this.swapper.buyBid(pending);
    await recordBuybackSpend(pending, txSig, this.prisma); // PLATFORM -> EXTERNAL (USDC leaves)
    return this.prisma.buyback.create({
      data: { amount: pending, txSig, status: 'EXECUTED' },
    });
  }
}
