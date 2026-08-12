/**
 * Go-live alerts. A user can opt in to be notified when a specific seller goes
 * live, or when any stream in a category goes live. When a seller's stream flips
 * live (native via Cloudflare, or pump.fun via the poller), `notifyLive` fans out
 * an in-app notification (and, for direct follows, an email) to everyone who
 * opted in.
 *
 * One `LiveAlertPref` row per opt-in: either `sellerId` (a streamer) or
 * `category` is set. See schema.prisma.
 */
import { prisma as defaultPrisma } from './db.js';
import type { PrismaClient } from './db.js';
import { notify } from './notifications.js';

export class AlertError extends Error {}

const CATEGORY_MAX = 40;

/** Follow / unfollow a seller's go-live alerts. `sellerId` is the seller's User id
 *  (the watch-page room). Returns the resulting state. */
export async function setSellerAlert(
  userId: string,
  sellerId: string,
  on: boolean,
  prisma: PrismaClient = defaultPrisma,
): Promise<{ on: boolean }> {
  if (!sellerId || sellerId === userId) throw new AlertError('bad seller');
  if (on) {
    const seller = await prisma.sellerProfile.findUnique({ where: { userId: sellerId }, select: { userId: true } });
    if (!seller) throw new AlertError('not a seller');
    await prisma.liveAlertPref.upsert({
      where: { userId_sellerId: { userId, sellerId } },
      create: { userId, sellerId },
      update: {},
    });
  } else {
    await prisma.liveAlertPref.deleteMany({ where: { userId, sellerId } });
  }
  return { on };
}

/** Subscribe / unsubscribe to go-live alerts for a whole category. */
export async function setCategoryAlert(
  userId: string,
  categoryRaw: string,
  on: boolean,
  prisma: PrismaClient = defaultPrisma,
): Promise<{ on: boolean; category: string }> {
  const category = (categoryRaw ?? '').trim().slice(0, CATEGORY_MAX);
  if (!category) throw new AlertError('bad category');
  if (on) {
    await prisma.liveAlertPref.upsert({
      where: { userId_category: { userId, category } },
      create: { userId, category },
      update: {},
    });
  } else {
    await prisma.liveAlertPref.deleteMany({ where: { userId, category } });
  }
  return { on, category };
}

/** All of a user's opt-ins: the sellers they follow (with handle) + categories. */
export async function getAlertPrefs(userId: string, prisma: PrismaClient = defaultPrisma) {
  const rows = await prisma.liveAlertPref.findMany({ where: { userId } });
  const sellerIds = rows.map((r) => r.sellerId).filter((s): s is string => !!s);
  const categories = rows.map((r) => r.category).filter((c): c is string => !!c).sort();
  const handles = sellerIds.length
    ? await prisma.user.findMany({ where: { id: { in: sellerIds } }, select: { id: true, handle: true } })
    : [];
  const handleById = new Map(handles.map((h) => [h.id, h.handle]));
  return {
    sellers: sellerIds
      .map((id) => ({ sellerId: id, handle: handleById.get(id) ?? null }))
      .filter((s) => s.handle),
    categories,
  };
}

/**
 * Fan out "went live" alerts for a seller to everyone who opted in — the seller's
 * direct followers, plus subscribers to the seller's category. Deduped, and the
 * seller never notifies themselves. Direct follows get an email too; category
 * alerts are in-app only (they can be high-volume). Never throws; returns the
 * number of people notified.
 */
export async function notifyLive(sellerId: string, prisma: PrismaClient = defaultPrisma): Promise<number> {
  const profile = await prisma.sellerProfile.findUnique({
    where: { userId: sellerId },
    select: { streamTitle: true, streamCategory: true, user: { select: { handle: true } } },
  });
  if (!profile) return 0;
  const handle = profile.user.handle;

  // via=true means a direct seller-follow (gets an email); category-only is in-app.
  const recipients = new Map<string, boolean>();
  const followers = await prisma.liveAlertPref.findMany({ where: { sellerId }, select: { userId: true } });
  for (const f of followers) if (f.userId !== sellerId) recipients.set(f.userId, true);
  if (profile.streamCategory) {
    const subs = await prisma.liveAlertPref.findMany({
      where: { category: profile.streamCategory },
      select: { userId: true },
    });
    for (const s of subs) if (s.userId !== sellerId && !recipients.has(s.userId)) recipients.set(s.userId, false);
  }
  if (recipients.size === 0) return 0;

  const title = `@${handle} is live on BIDit`;
  const body = profile.streamTitle?.trim() || 'Their stream just started. Come bid.';
  const href = `/live/@${handle}`;
  await Promise.all(
    [...recipients].map(([uid, viaFollow]) =>
      notify({ userId: uid, kind: 'stream-live', title, body, href, email: viaFollow }, prisma).catch(() => {}),
    ),
  );
  return recipients.size;
}
