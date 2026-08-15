/**
 * Direct messages: one thread per user pair, started from a marketplace listing
 * or an existing order (so strangers can't cold-DM arbitrary users). Offers ride
 * inside the thread as OFFER messages (see offers.ts); SYSTEM messages record
 * accept/decline/expiry outcomes.
 *
 * Reads are poll-based (the messages page polls the thread; the nav polls the
 * unread count). Unread = messages after MY lastReadAt that I didn't send.
 */
import { prisma as defaultPrisma } from './db.js';
import type { PrismaClient } from './db.js';
import { notify } from './notifications.js';
import type { Clock } from './clock.js';
import { systemClock } from './clock.js';

export class MessageError extends Error {}

const MAX_TEXT = 2000;
const PAGE = 50;

/** Normalize a pair so (a,b) and (b,a) hit the same unique row. */
function pairOf(u1: string, u2: string): { aId: string; bId: string } {
  return u1 < u2 ? { aId: u1, bId: u2 } : { aId: u2, bId: u1 };
}

function sideOf(conv: { aId: string; bId: string }, userId: string): 'a' | 'b' {
  if (conv.aId === userId) return 'a';
  if (conv.bId === userId) return 'b';
  throw new MessageError('That conversation was not found.');
}

/**
 * May `userId` open a thread with `otherId`? Yes when the other side is a
 * seller (any listing/storefront is an invitation to talk), when the two
 * already share an order, or when a thread already exists (replies are always
 * allowed). This is the anti-spam gate: you can't cold-DM a random buyer.
 */
async function canConverse(userId: string, otherId: string, prisma: PrismaClient): Promise<boolean> {
  const { aId, bId } = pairOf(userId, otherId);
  const [existing, otherSeller, sharedOrder] = await Promise.all([
    prisma.conversation.findUnique({ where: { aId_bId: { aId, bId } }, select: { id: true } }),
    prisma.sellerProfile.findUnique({ where: { userId: otherId }, select: { id: true } }),
    prisma.order.findFirst({
      where: {
        OR: [
          { buyerId: userId, sellerId: otherId },
          { buyerId: otherId, sellerId: userId },
        ],
      },
      select: { id: true },
    }),
  ]);
  return existing !== null || otherSeller !== null || sharedOrder !== null;
}

/** Open (or find) the thread between two users. */
export async function startConversation(
  userId: string,
  otherId: string,
  prisma: PrismaClient = defaultPrisma,
): Promise<{ conversationId: string }> {
  if (!otherId || otherId === userId) throw new MessageError('You can’t message yourself.');
  const other = await prisma.user.findUnique({ where: { id: otherId }, select: { id: true } });
  if (!other) throw new MessageError('That user was not found.');
  if (!(await canConverse(userId, otherId, prisma))) {
    throw new MessageError('You can message sellers, and anyone you have an order with.');
  }
  const { aId, bId } = pairOf(userId, otherId);
  const conv = await prisma.conversation.upsert({
    where: { aId_bId: { aId, bId } },
    update: {},
    create: { aId, bId },
  });
  return { conversationId: conv.id };
}

async function requireParticipant(conversationId: string, userId: string, prisma: PrismaClient) {
  const conv = await prisma.conversation.findUnique({ where: { id: conversationId } });
  if (!conv || (conv.aId !== userId && conv.bId !== userId)) {
    throw new MessageError('That conversation was not found.');
  }
  return conv;
}

/** Send a plain text message. */
export async function sendMessage(
  conversationId: string,
  senderId: string,
  textRaw: string,
  clock: Clock = systemClock,
  prisma: PrismaClient = defaultPrisma,
): Promise<{ messageId: string }> {
  const conv = await requireParticipant(conversationId, senderId, prisma);
  const text = (textRaw ?? '').trim();
  if (text.length === 0) throw new MessageError('Write something first.');
  if (text.length > MAX_TEXT) throw new MessageError(`Keep it under ${MAX_TEXT} characters.`);

  // createdAt from the injected clock (not the DB default) so read-marks,
  // which also come from the clock, always compare against the same timeline.
  const msg = await prisma.directMessage.create({
    data: { conversationId, senderId, kind: 'TEXT', text, createdAt: clock.now() },
  });
  await touchConversation(conv.id, senderId, clock, prisma);

  const recipientId = conv.aId === senderId ? conv.bId : conv.aId;
  const sender = await prisma.user.findUnique({ where: { id: senderId }, select: { handle: true } });
  await notify(
    {
      userId: recipientId,
      kind: 'message',
      title: `New message from @${sender?.handle ?? 'someone'}`,
      body: text.length > 120 ? `${text.slice(0, 117)}...` : text,
      href: `/messages/${conv.id}`,
      email: false, // a DM ping per message would be email spam
    },
    prisma,
  );
  return { messageId: msg.id };
}

/** Insert a non-TEXT message (OFFER card / SYSTEM notice) into the pair's
 *  thread, creating it if needed. Used by offers.ts; skips the converse gate
 *  because an offer on a listing IS the legitimate introduction. */
export async function postThreadEvent(
  params: {
    u1: string;
    u2: string;
    senderId: string;
    kind: 'OFFER' | 'SYSTEM';
    text?: string;
    listingId?: string;
    offerId?: string;
  },
  clock: Clock = systemClock,
  prisma: PrismaClient = defaultPrisma,
): Promise<{ conversationId: string }> {
  const { aId, bId } = pairOf(params.u1, params.u2);
  const conv = await prisma.conversation.upsert({
    where: { aId_bId: { aId, bId } },
    update: {},
    create: { aId, bId },
  });
  await prisma.directMessage.create({
    data: {
      conversationId: conv.id,
      senderId: params.senderId,
      kind: params.kind,
      text: params.text ?? null,
      listingId: params.listingId ?? null,
      offerId: params.offerId ?? null,
      createdAt: clock.now(),
    },
  });
  await touchConversation(conv.id, params.senderId, clock, prisma);
  return { conversationId: conv.id };
}

/** Bump lastMessageAt and mark the sender's own side read (their view is
 *  current the moment they send). */
async function touchConversation(conversationId: string, senderId: string, clock: Clock, prisma: PrismaClient) {
  const now = clock.now();
  const conv = await prisma.conversation.findUniqueOrThrow({ where: { id: conversationId } });
  const side = sideOf(conv, senderId);
  await prisma.conversation.update({
    where: { id: conversationId },
    data: { lastMessageAt: now, ...(side === 'a' ? { aLastReadAt: now } : { bLastReadAt: now }) },
  });
}

export interface InboxRow {
  conversationId: string;
  other: { id: string; handle: string; avatarUrl: string | null };
  lastMessageAt: number;
  preview: string | null;
  previewKind: string;
  unread: number;
}

/** The user's inbox, newest thread first, with unread counts. */
export async function listConversations(userId: string, prisma: PrismaClient = defaultPrisma): Promise<InboxRow[]> {
  const convs = await prisma.conversation.findMany({
    where: { OR: [{ aId: userId }, { bId: userId }] },
    orderBy: { lastMessageAt: 'desc' },
    take: 100,
    include: {
      a: { select: { id: true, handle: true, avatarUrl: true } },
      b: { select: { id: true, handle: true, avatarUrl: true } },
      messages: { orderBy: { createdAt: 'desc' }, take: 1 },
    },
  });
  const rows: InboxRow[] = [];
  for (const c of convs) {
    const mySide = sideOf(c, userId);
    const other = mySide === 'a' ? c.b : c.a;
    const lastRead = mySide === 'a' ? c.aLastReadAt : c.bLastReadAt;
    const unread = await prisma.directMessage.count({
      where: {
        conversationId: c.id,
        senderId: { not: userId },
        ...(lastRead ? { createdAt: { gt: lastRead } } : {}),
      },
    });
    const last = c.messages[0] ?? null;
    rows.push({
      conversationId: c.id,
      other: { id: other.id, handle: other.handle, avatarUrl: other.avatarUrl },
      lastMessageAt: c.lastMessageAt.getTime(),
      preview: last?.kind === 'TEXT' ? last.text : last?.kind === 'OFFER' ? 'Offer' : (last?.text ?? null),
      previewKind: last?.kind ?? 'TEXT',
      unread,
    });
  }
  return rows;
}

export interface ThreadMessage {
  id: string;
  senderId: string;
  kind: string;
  text: string | null;
  listingId: string | null;
  offerId: string | null;
  at: number;
}

/** A thread's messages (oldest first) + the other participant. Marks the
 *  viewer's side read. `after` fetches only newer messages, for cheap polling. */
export async function getThread(
  conversationId: string,
  userId: string,
  opts: { after?: number } = {},
  clock: Clock = systemClock,
  prisma: PrismaClient = defaultPrisma,
) {
  const conv = await requireParticipant(conversationId, userId, prisma);
  const mySide = sideOf(conv, userId);
  const otherId = mySide === 'a' ? conv.bId : conv.aId;
  const other = await prisma.user.findUniqueOrThrow({
    where: { id: otherId },
    select: { id: true, handle: true, avatarUrl: true, sellerProfile: { select: { verified: true } } },
  });

  const messages = await prisma.directMessage.findMany({
    where: {
      conversationId,
      ...(opts.after ? { createdAt: { gt: new Date(opts.after) } } : {}),
    },
    orderBy: { createdAt: 'asc' },
    take: opts.after ? 200 : PAGE,
    ...(opts.after ? {} : { skip: 0 }),
  });
  // Without `after`, show the most recent page (fetch desc then reverse).
  const page = opts.after
    ? messages
    : (
        await prisma.directMessage.findMany({
          where: { conversationId },
          orderBy: { createdAt: 'desc' },
          take: PAGE,
        })
      ).reverse();

  const now = clock.now();
  await prisma.conversation.update({
    where: { id: conversationId },
    data: mySide === 'a' ? { aLastReadAt: now } : { bLastReadAt: now },
  });

  return {
    conversationId,
    other: {
      id: other.id,
      handle: other.handle,
      avatarUrl: other.avatarUrl,
      verified: other.sellerProfile?.verified ?? false,
    },
    messages: page.map(
      (m): ThreadMessage => ({
        id: m.id,
        senderId: m.senderId,
        kind: m.kind,
        text: m.text,
        listingId: m.listingId,
        offerId: m.offerId,
        at: m.createdAt.getTime(),
      }),
    ),
    serverNow: now.getTime(),
  };
}

/** Total unread messages across all threads (the nav badge). */
export async function unreadTotal(userId: string, prisma: PrismaClient = defaultPrisma): Promise<number> {
  const convs = await prisma.conversation.findMany({
    where: { OR: [{ aId: userId }, { bId: userId }] },
    select: { id: true, aId: true, bId: true, aLastReadAt: true, bLastReadAt: true },
    take: 200,
  });
  let total = 0;
  for (const c of convs) {
    const lastRead = c.aId === userId ? c.aLastReadAt : c.bLastReadAt;
    total += await prisma.directMessage.count({
      where: {
        conversationId: c.id,
        senderId: { not: userId },
        ...(lastRead ? { createdAt: { gt: lastRead } } : {}),
      },
    });
  }
  return total;
}
