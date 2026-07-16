/**
 * Shipment tracking → delivery → escrow release.
 *
 * A TrackingProvider tells us the carrier status of a tracking number. The
 * ShipmentTracker polls in-flight shipments and, on delivery, marks the shipment
 * DELIVERED and opens the 2-day dispute window on the linked order(s) — after
 * which processOrderTimers auto-releases the escrow. Mirrors DepositWatcher.
 *
 * The provider is behind an interface so tests inject a deterministic mock;
 * ShippoTracker is the real implementation (used when SHIPPO_API_KEY is set).
 */
import { prisma as defaultPrisma } from './db.js';
import type { PrismaClient } from './db.js';
import { systemClock, type Clock } from './clock.js';
import { markShipmentDelivered } from './fulfillment.js';
import { advanceOrdersForShipment } from './orders.js';

export type TrackStatus = 'pre_transit' | 'transit' | 'delivered' | 'failure' | 'unknown';

export interface TrackingProvider {
  /** Current carrier status for a tracking number. Never throws — returns
   *  'unknown' on any error so a flaky lookup just retries next tick. */
  getStatus(carrier: string, trackingNumber: string): Promise<TrackStatus>;
}

/** Real Shippo tracking. Test mode: carrier 'shippo' + tracking 'SHIPPO_DELIVERED'
 *  / 'SHIPPO_TRANSIT' return those statuses. */
export class ShippoTracker implements TrackingProvider {
  constructor(private readonly apiKey: string) {}

  async getStatus(carrier: string, trackingNumber: string): Promise<TrackStatus> {
    const token = (carrier || 'shippo').toLowerCase().replace(/[^a-z0-9]/g, '') || 'shippo';
    try {
      const res = await fetch(`https://api.goshippo.com/tracks/${token}/${encodeURIComponent(trackingNumber)}`, {
        headers: { Authorization: `ShippoToken ${this.apiKey}` },
      });
      if (!res.ok) return 'unknown';
      const data = (await res.json()) as { tracking_status?: { status?: string } };
      switch (String(data?.tracking_status?.status ?? '').toUpperCase()) {
        case 'DELIVERED':
          return 'delivered';
        case 'TRANSIT':
          return 'transit';
        case 'FAILURE':
        case 'RETURNED':
          return 'failure';
        case 'PRE_TRANSIT':
          return 'pre_transit';
        default:
          return 'unknown';
      }
    } catch {
      return 'unknown';
    }
  }
}

/** Deterministic provider for tests: set a status per tracking number. */
export class MockTrackingProvider implements TrackingProvider {
  private readonly statuses = new Map<string, TrackStatus>();
  set(trackingNumber: string, status: TrackStatus): void {
    this.statuses.set(trackingNumber, status);
  }
  async getStatus(_carrier: string, trackingNumber: string): Promise<TrackStatus> {
    return this.statuses.get(trackingNumber) ?? 'unknown';
  }
}

/** ShippoTracker when SHIPPO_API_KEY is set, otherwise null (tracking disabled — a
 *  local/dev deploy without Shippo relies on buyer-confirm or the admin override). */
export function getTrackingProvider(): TrackingProvider | null {
  const key = process.env.SHIPPO_API_KEY;
  return key ? new ShippoTracker(key) : null;
}

/**
 * Polls in-flight shipments and drives delivery. On the first movement a
 * LABEL_CREATED package auto-advances to SHIPPED; on delivery it advances to
 * DELIVERED and opens the dispute window on the order(s). Never throws.
 */
export class ShipmentTracker {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly provider: TrackingProvider,
    private readonly prisma: PrismaClient = defaultPrisma,
    private readonly clock: Clock = systemClock,
    private readonly intervalMs = 120_000,
    /** Called with the buyerId when a shipment is delivered (to notify + refresh). */
    private readonly onDelivered?: (buyerId: string, shipmentId: string) => void,
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

  /** One poll. Returns how many shipments were newly marked delivered. */
  async tick(): Promise<number> {
    let delivered = 0;
    try {
      const shipments = await this.prisma.shipment.findMany({
        where: { status: { in: ['LABEL_CREATED', 'SHIPPED'] }, trackingNumber: { not: null } },
        take: 200,
      });
      for (const s of shipments) {
        try {
          const status = await this.provider.getStatus(s.carrier ?? '', s.trackingNumber!);
          if (status !== 'transit' && status !== 'delivered') continue;
          // First movement: a label-made package is now actually in transit.
          if (s.status === 'LABEL_CREATED') {
            await this.prisma.shipment.update({ where: { id: s.id }, data: { status: 'SHIPPED', shippedAt: this.clock.now() } });
            await this.prisma.fulfillmentItem.updateMany({ where: { shipmentId: s.id }, data: { status: 'SHIPPED' } });
            await advanceOrdersForShipment(s.id, 'SHIPPED', this.clock, this.prisma);
          }
          if (status === 'delivered') {
            await markShipmentDelivered(s.id, this.clock, this.prisma);
            await advanceOrdersForShipment(s.id, 'DISPUTE_WINDOW', this.clock, this.prisma);
            try {
              this.onDelivered?.(s.buyerId, s.id);
            } catch {
              /* a notify failure must never break tracking */
            }
            delivered += 1;
          }
        } catch (err) {
          console.error('[tracking] shipment failed for', s.id, (err as Error)?.message ?? err);
        }
      }
    } catch (err) {
      console.error('[tracking] poll failed (will retry):', (err as Error)?.message ?? err);
    }
    return delivered;
  }
}
