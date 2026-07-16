/**
 * Giveaways (Whatnot-style) — the authoritative server logic.
 *
 * A seller opens a giveaway during a live stream; viewers enter with one tap.
 * Two kinds gate who may enter:
 *   - PUBLIC       any authenticated viewer
 *   - BUYER_ONLY   only users who have bought from this seller
 * The winner is drawn from a seed committed when the giveaway opened, so the
 * outcome is a pure function of (seed, ordered entrants) and can be re-verified.
 * Entry is only possible while the giveaway is OPEN and inside its window, so the
 * entrant set is frozen by draw time and the draw is idempotent.
 */
import { createHash, randomBytes } from 'node:crypto';
import {
  normalizeGiveawayKind,
  pickWinnerIndex,
  type GiveawayKind,
  type GiveawayEntrant,
} from '@bidit/shared';
import { prisma as defaultPrisma } from './db.js';
import type { PrismaClient } from './db.js';
import { systemClock, type Clock } from './clock.js';

export type GiveawayEnterReason = 'NOT_ELIGIBLE' | 'CLOSED' | 'NOT_OPEN';

export interface OpenGiveawayInput {
  kind: GiveawayKind;
  prize: string;
  image?: string | null;
  durationMs?: number;
}

const DEFAULT_DURATION_MS = 30_000;
const MIN_DURATION_MS = 5_000;
const MAX_DURATION_MS = 10 * 60_000;

/** Open a giveaway for a seller: commit a seed and set the entry window. */
export async function openGiveaway(
  sellerId: string,
  input: OpenGiveawayInput,
  clock: Clock = systemClock,
  prisma: PrismaClient = defaultPrisma,
) {
  const prize = (input.prize ?? '').trim();
  if (!prize) throw new Error('giveaway needs a prize');
  const kind = normalizeGiveawayKind(input.kind);
  const dur = Math.min(
    MAX_DURATION_MS,
    Math.max(MIN_DURATION_MS, Math.floor(input.durationMs ?? DEFAULT_DURATION_MS)),
  );
  const now = clock.now();
  const seed = randomBytes(16).toString('hex');
  const seedHash = createHash('sha256').update(seed).digest('hex');
  const image = typeof input.image === 'string' && input.image.trim() ? input.image.trim() : null;
  return prisma.giveaway.create({
    data: {
      sellerId,
      kind,
      prize,
      image,
      status: 'OPEN',
      seed,
      seedHash,
      opensAt: now,
      closesAt: new Date(now.getTime() + dur),
    },
  });
}

/** Whether a user may enter — BUYER_ONLY requires a purchase from this seller. */
export async function isEligible(
  giveaway: { sellerId: string; kind: string },
  userId: string,
  prisma: PrismaClient = defaultPrisma,
): Promise<boolean> {
  if (giveaway.kind !== 'BUYER_ONLY') return true;
  const order = await prisma.order.findFirst({
    where: { sellerId: giveaway.sellerId, buyerId: userId },
    select: { id: true },
  });
  return order !== null;
}

export type EnterResult =
  | { ok: true; count: number; alreadyEntered: boolean }
  | { ok: false; reason: GiveawayEnterReason };

/** Record a viewer's entry (idempotent), enforcing eligibility + the window. */
export async function enterGiveaway(
  giveawayId: string,
  userId: string,
  clock: Clock = systemClock,
  prisma: PrismaClient = defaultPrisma,
): Promise<EnterResult> {
  const g = await prisma.giveaway.findUnique({ where: { id: giveawayId } });
  if (!g || g.status !== 'OPEN') return { ok: false, reason: 'NOT_OPEN' };
  if (clock.now().getTime() >= g.closesAt.getTime()) return { ok: false, reason: 'CLOSED' };
  if (!(await isEligible(g, userId, prisma))) return { ok: false, reason: 'NOT_ELIGIBLE' };

  const existing = await prisma.giveawayEntry.findUnique({
    where: { giveawayId_userId: { giveawayId, userId } },
    select: { id: true },
  });
  if (!existing) {
    // The unique index makes concurrent double-taps safe — swallow the race.
    await prisma.giveawayEntry.create({ data: { giveawayId, userId } }).catch(() => {});
  }
  const count = await prisma.giveawayEntry.count({ where: { giveawayId } });
  return { ok: true, count, alreadyEntered: existing !== null };
}

/** Ordered entrants (stable by createdAt, id) with handles — used for the roll. */
export async function listEntrants(
  giveawayId: string,
  prisma: PrismaClient = defaultPrisma,
): Promise<GiveawayEntrant[]> {
  const entries = await prisma.giveawayEntry.findMany({
    where: { giveawayId },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: { userId: true },
    take: 5000,
  });
  if (entries.length === 0) return [];
  const users = await prisma.user.findMany({
    where: { id: { in: entries.map((e) => e.userId) } },
    select: { id: true, handle: true },
  });
  const handleOf = new Map(users.map((u) => [u.id, u.handle]));
  return entries.map((e) => ({ userId: e.userId, handle: handleOf.get(e.userId) ?? 'anon' }));
}

export type DrawResult =
  | {
      ok: true;
      winner: GiveawayEntrant;
      winnerIndex: number;
      entrants: GiveawayEntrant[];
      seed: string;
      seedHash: string;
      prize: string;
      image: string | null;
      kind: GiveawayKind;
    }
  | { ok: false; reason: 'NO_ENTRANTS' | 'NOT_FOUND' };

/**
 * Draw the winner from the committed seed. Idempotent: entry is frozen once the
 * window closes, so recomputing from the stored seed always yields the same
 * winner — a repeat draw simply re-derives and re-broadcasts the same result.
 */
export async function drawGiveaway(
  giveawayId: string,
  clock: Clock = systemClock,
  prisma: PrismaClient = defaultPrisma,
): Promise<DrawResult> {
  const g = await prisma.giveaway.findUnique({ where: { id: giveawayId } });
  if (!g) return { ok: false, reason: 'NOT_FOUND' };

  const entrants = await listEntrants(giveawayId, prisma);
  if (entrants.length === 0) {
    if (g.status !== 'CLOSED') {
      await prisma.giveaway.update({
        where: { id: giveawayId },
        data: { status: 'CLOSED', drawnAt: clock.now() },
      });
    }
    return { ok: false, reason: 'NO_ENTRANTS' };
  }

  const winnerIndex = pickWinnerIndex(entrants.length, g.seed);
  const winner = entrants[winnerIndex]!;
  if (g.status !== 'CLOSED' || !g.winnerUserId) {
    await prisma.giveaway.update({
      where: { id: giveawayId },
      data: { status: 'CLOSED', winnerUserId: winner.userId, drawnAt: clock.now() },
    });
  }
  return {
    ok: true,
    winner,
    winnerIndex,
    entrants,
    seed: g.seed,
    seedHash: g.seedHash,
    prize: g.prize,
    image: g.image,
    kind: normalizeGiveawayKind(g.kind),
  };
}

/** The seller's current OPEN giveaway, if any (most recent). */
export async function getOpenGiveaway(
  sellerId: string,
  prisma: PrismaClient = defaultPrisma,
) {
  return prisma.giveaway.findFirst({
    where: { sellerId, status: 'OPEN' },
    orderBy: { createdAt: 'desc' },
  });
}
