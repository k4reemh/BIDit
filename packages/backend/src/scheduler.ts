/**
 * Drives auction closing from the server. A plain interval that polls for due
 * auctions; the heavy lifting (and the under-lock deadline re-check) lives in
 * closeDueAuctions. Polling Postgres is fine for v1 — a Redis sorted-set keyed
 * by endsAt can replace the poll later without touching callers.
 *
 * Tests call `tick()` directly with a ManualClock; they never start the interval.
 */
import { closeDueAuctions, type CloseResult } from './auction.js';
import { systemClock, type Clock } from './clock.js';
import { prisma as defaultPrisma } from './db.js';
import type { PrismaClient } from './db.js';

export interface AuctionSchedulerOptions {
  clock?: Clock;
  prisma?: PrismaClient;
  intervalMs?: number;
  onClose?: (results: CloseResult[]) => void;
  onError?: (err: unknown) => void;
}

export class AuctionScheduler {
  private readonly clock: Clock;
  private readonly prisma: PrismaClient;
  private readonly intervalMs: number;
  private readonly onClose?: (results: CloseResult[]) => void;
  private readonly onError?: (err: unknown) => void;
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;

  constructor(options: AuctionSchedulerOptions = {}) {
    this.clock = options.clock ?? systemClock;
    this.prisma = options.prisma ?? defaultPrisma;
    this.intervalMs = options.intervalMs ?? 250;
    this.onClose = options.onClose;
    this.onError = options.onError;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    // Don't keep the process alive just for the scheduler.
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** One poll. Guards against overlapping runs if a tick runs long. */
  async tick(): Promise<CloseResult[]> {
    if (this.ticking) return [];
    this.ticking = true;
    try {
      const results = await closeDueAuctions(this.clock, this.prisma);
      if (results.length > 0) this.onClose?.(results);
      return results;
    } catch (err) {
      this.onError?.(err);
      return [];
    } finally {
      this.ticking = false;
    }
  }
}
