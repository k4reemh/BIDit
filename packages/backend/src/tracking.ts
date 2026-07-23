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
import { markShipmentShipped, markShipmentDelivered } from './fulfillment.js';
import { advanceOrdersForShipment } from './orders.js';

export type TrackStatus = 'pre_transit' | 'transit' | 'delivered' | 'failure' | 'unknown';

export interface TrackingProvider {
  /** Current carrier status for a tracking number. Never throws — returns
   *  'unknown' on any error so a flaky lookup just retries next tick. */
  getStatus(carrier: string, trackingNumber: string): Promise<TrackStatus>;
}

/**
 * Shippo needs an EXACT carrier token (`usps`, `ups`, `fedex`, `dhl_express`,
 * `canada_post`…). Operators type free text ("Canada Post", "DHL"), so map the
 * common spellings. Naively lowercasing and stripping punctuation silently breaks
 * every multi-word token (canada_post → canadapost → 404).
 */
const CARRIER_TOKENS: Record<string, string> = {
  usps: 'usps',
  'united states postal service': 'usps',
  'us postal service': 'usps',
  ups: 'ups',
  fedex: 'fedex',
  'federal express': 'fedex',
  dhl: 'dhl_express',
  'dhl express': 'dhl_express',
  'dhl ecommerce': 'dhl_ecommerce',
  'canada post': 'canada_post',
  canadapost: 'canada_post',
  purolator: 'purolator',
  'royal mail': 'royal_mail',
  'australia post': 'australia_post',
  ontrac: 'ontrac',
  lasership: 'lasership',
};

/** Best-effort carrier guess from the tracking-number shape. The rescue path for
 *  labels saved before the carrier field was required — without it those shipments
 *  can never be tracked. Only guesses when the pattern is distinctive. */
export function guessCarrier(tracking: string): string | null {
  const t = tracking.replace(/\s+/g, '').toUpperCase();
  if (/^1Z[0-9A-Z]{16}$/.test(t)) return 'ups';
  if (/^(94|93|92|95|82)\d{18,20}$/.test(t)) return 'usps';
  if (/^[A-Z]{2}\d{9}US$/.test(t)) return 'usps'; // USPS international
  if (/^[A-Z]{2}\d{9}CA$/.test(t)) return 'canada_post';
  if (/^\d{16}$/.test(t)) return 'canada_post';
  if (/^\d{12}$/.test(t) || /^\d{15}$/.test(t) || /^\d{20}$/.test(t) || /^\d{22}$/.test(t)) return 'fedex';
  if (/^\d{10}$/.test(t)) return 'dhl_express';
  return null;
}

/** Resolve the Shippo carrier token from what the operator typed, falling back to
 *  the tracking-number shape. Returns null when we genuinely can't tell — better to
 *  log loudly than to query the wrong (or the `shippo` TEST) carrier and get 404s. */
export function resolveCarrierToken(carrier: string | null | undefined, tracking: string): string | null {
  const raw = (carrier ?? '').trim().toLowerCase().replace(/[\s_-]+/g, ' ');
  if (raw) {
    const mapped = CARRIER_TOKENS[raw];
    if (mapped) return mapped;
    // Already an exact Shippo-style token (lowercase, underscores) — pass through.
    const asToken = raw.replace(/\s+/g, '_');
    if (/^[a-z][a-z0-9_]{1,}$/.test(asToken)) return asToken;
  }
  return guessCarrier(tracking);
}

/** Real Shippo tracking. Test mode: carrier 'shippo' + tracking 'SHIPPO_DELIVERED'
 *  / 'SHIPPO_TRANSIT' return those statuses. */
export class ShippoTracker implements TrackingProvider {
  constructor(private readonly apiKey: string) {}

  async getStatus(carrier: string, trackingNumber: string): Promise<TrackStatus> {
    const token = resolveCarrierToken(carrier, trackingNumber);
    if (!token) {
      // Never fall back to Shippo's `shippo` TEST carrier — a real tracking number
      // 404s there, which is exactly how a delivered package stays "not delivered".
      console.warn(
        `[tracking] no carrier for ${trackingNumber} (carrier=${JSON.stringify(carrier)}) — set the carrier on the label so Shippo can be queried`,
      );
      return 'unknown';
    }
    try {
      const res = await fetch(`https://api.goshippo.com/tracks/${token}/${encodeURIComponent(trackingNumber)}`, {
        headers: { Authorization: `ShippoToken ${this.apiKey}` },
      });
      if (!res.ok) {
        // Loud on purpose: a silent 401/404 here is invisible, and the shipment just
        // sits un-tracked forever (401 = bad/!live key, 404 = wrong carrier token).
        const body = await res.text().catch(() => '');
        console.error(`[tracking] shippo ${res.status} for ${token}/${trackingNumber}: ${body.slice(0, 200)}`);
        return 'unknown';
      }
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
    } catch (err) {
      console.error(`[tracking] shippo request failed for ${token}/${trackingNumber}:`, (err as Error)?.message ?? err);
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
          // First movement: the carrier has the package — mark it shipped (notifies
          // the buyer, closes any weekly bundle). This is the ONLY thing that flips a
          // package to SHIPPED in normal operation; the seller never self-attests.
          if (s.status === 'LABEL_CREATED') {
            await markShipmentShipped(s.id, this.clock, this.prisma);
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
