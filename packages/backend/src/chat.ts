/**
 * Live chat — the authoritative domain logic for a seller's room chat.
 *
 * A "room" is a seller's userId (same key the auction/giveaway broadcasts use).
 * Any logged-in viewer may post; the seller (the room owner) can delete a message
 * or block a user. Anti-abuse: a per-user cooldown (read from the DB so it holds
 * across server instances), a length + control-char clamp, and the block list.
 * The WebSocket layer (realtime/server.ts) is a thin wrapper over these functions,
 * mirroring how giveaways.ts backs the giveaway handlers.
 */
import { prisma as defaultPrisma } from './db.js';
import { mediaUrl } from './media.js';
import type { PrismaClient } from './db.js';
import { systemClock, type Clock } from './clock.js';

export const CHAT_MAX_LEN = 300;
export const CHAT_COOLDOWN_MS = 5000; // default: one message per user per 5s (seller-configurable)
export const CHAT_BACKLOG = 10; // messages sent to a viewer on join

export type ChatRejectReason = 'COOLDOWN' | 'BLOCKED' | 'EMPTY' | 'TOO_LONG';

/** A rejected chat action, surfaced to the sender as CHAT_REJECTED. */
export class ChatError extends Error {
  constructor(
    readonly reason: ChatRejectReason,
    /** For COOLDOWN: ms the sender should wait before retrying. */
    readonly retryMs?: number,
  ) {
    super(reason);
    this.name = 'ChatError';
  }
}

/** Trim, strip control chars (a chat line is single-line), and enforce length.
 *  Throws EMPTY (nothing left after trim) / TOO_LONG (before clamping, so a wall
 *  of text is rejected rather than silently truncated). */
export function sanitizeChatText(raw: string): string {
  const text = (raw ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!text) throw new ChatError('EMPTY');
  if (text.length > CHAT_MAX_LEN) throw new ChatError('TOO_LONG');
  return text;
}

/** The room owner's configured chat cooldown in ms (null → CHAT_COOLDOWN_MS default,
 *  0 → off). Room === the seller's userId, so it's a SellerProfile lookup. */
export async function roomChatCooldownMs(room: string, prisma: PrismaClient = defaultPrisma): Promise<number> {
  const profile = await prisma.sellerProfile.findUnique({ where: { userId: room }, select: { chatCooldownMs: true } });
  return profile?.chatCooldownMs ?? CHAT_COOLDOWN_MS;
}

/** Whether `userId` is blocked from `room`'s chat. */
export async function isChatBlocked(
  room: string,
  userId: string,
  prisma: PrismaClient = defaultPrisma,
): Promise<boolean> {
  const row = await prisma.chatBlock.findUnique({ where: { roomId_userId: { roomId: room, userId } }, select: { id: true } });
  return !!row;
}

export interface PostedChat {
  id: string;
  roomId: string;
  userId: string;
  handle: string;
  /** Sender's profile photo, resolved live from the User row (NOT snapshotted
   *  like `handle`) so a changed avatar updates everywhere, including backlog. */
  avatarUrl: string | null;
  text: string;
  createdAt: Date;
}

/**
 * Post a chat message to a room. Enforces (in order): not blocked, valid text,
 * cooldown since the sender's last message in this room. Persists and returns the
 * row for broadcast. Throws ChatError on any rejection.
 */
export async function postChatMessage(
  params: { room: string; userId: string; text: string },
  clock: Clock = systemClock,
  prisma: PrismaClient = defaultPrisma,
): Promise<PostedChat> {
  if (await isChatBlocked(params.room, params.userId, prisma)) throw new ChatError('BLOCKED');
  const text = sanitizeChatText(params.text);

  // The room owner (seller) sets the cooldown; 0 = off (skip the check entirely).
  const cooldown = await roomChatCooldownMs(params.room, prisma);
  if (cooldown > 0) {
    // DB-backed cooldown: the sender's most recent message in this room (deleted or
    // not — you can't delete your own, so this can't be gamed). Authoritative across
    // instances, unlike an in-memory timer.
    const last = await prisma.chatMessage.findFirst({
      where: { roomId: params.room, userId: params.userId },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    });
    const since = last ? clock.now().getTime() - last.createdAt.getTime() : Infinity;
    if (since < cooldown) throw new ChatError('COOLDOWN', cooldown - since);
  }
  const now = clock.now();

  const sender = await prisma.user.findUnique({
    where: { id: params.userId },
    select: { handle: true, avatarUrl: true },
  });
  const handle = sender?.handle ?? 'someone';
  const row = await prisma.chatMessage.create({
    data: { roomId: params.room, userId: params.userId, handle, text, createdAt: now },
    select: { id: true, roomId: true, userId: true, handle: true, text: true, createdAt: true },
  });
  // A URL, never the inline image: a 50-line backlog of data URLs was megabytes.
  return { ...row, avatarUrl: mediaUrl('avatar', params.userId, sender?.avatarUrl) };
}

/**
 * Who may moderate a room: the seller who owns it, plus anyone they've added as
 * a moderator. Moderators get exactly the chat powers (delete, block, cooldown)
 * and nothing else — listings, orders and money stay owner-only.
 */
export async function canModerateRoom(
  room: string,
  userId: string,
  prisma: PrismaClient = defaultPrisma,
): Promise<boolean> {
  if (userId === room) return true;
  const mod = await prisma.chatModerator.findUnique({
    where: { roomId_userId: { roomId: room, userId } },
    select: { id: true },
  });
  return !!mod;
}

/** A moderator-management failure (bad handle, etc). Distinct from ChatError,
 *  whose reasons are a closed union on the realtime protocol. */
export class ModeratorError extends Error {
  readonly status = 400;
  constructor(message: string) {
    super(message);
    this.name = 'ModeratorError';
  }
}

/** The seller's moderator list, for managing it in Settings. */
export async function listRoomModerators(
  room: string,
  prisma: PrismaClient = defaultPrisma,
): Promise<{ userId: string; handle: string; addedAt: Date }[]> {
  return prisma.chatModerator.findMany({
    where: { roomId: room },
    orderBy: { addedAt: 'asc' },
    select: { userId: true, handle: true, addedAt: true },
  });
}

/** Owner-only: trust a user (by handle) to moderate this room. Idempotent. */
export async function addRoomModerator(
  room: string,
  handle: string,
  prisma: PrismaClient = defaultPrisma,
): Promise<{ userId: string; handle: string }> {
  const clean = handle.trim().replace(/^@/, '').toLowerCase();
  if (!clean) throw new ModeratorError('Enter the username to add.');
  const user = await prisma.user.findUnique({ where: { handle: clean }, select: { id: true, handle: true } });
  if (!user) throw new ModeratorError('No user with that username.');
  if (user.id === room) throw new ModeratorError('You already have every moderator power in your own room.');
  await prisma.chatModerator.upsert({
    where: { roomId_userId: { roomId: room, userId: user.id } },
    create: { roomId: room, userId: user.id, handle: user.handle },
    update: { handle: user.handle },
  });
  return { userId: user.id, handle: user.handle };
}

/** Owner-only: take moderator rights back. Idempotent. */
export async function removeRoomModerator(
  room: string,
  userId: string,
  prisma: PrismaClient = defaultPrisma,
): Promise<void> {
  await prisma.chatModerator.deleteMany({ where: { roomId: room, userId } });
}

/** Delete a message from a room (soft delete). The room owner or one of their
 *  moderators may delete. Returns true if a row was hidden. */
export async function deleteChatMessage(
  params: { room: string; messageId: string; byUserId: string },
  clock: Clock = systemClock,
  prisma: PrismaClient = defaultPrisma,
): Promise<boolean> {
  if (!(await canModerateRoom(params.room, params.byUserId, prisma))) {
    throw new ChatError('BLOCKED'); // neither the room owner nor a moderator
  }
  const res = await prisma.chatMessage.updateMany({
    where: { id: params.messageId, roomId: params.room, deletedAt: null },
    data: { deletedAt: clock.now() },
  });
  return res.count === 1;
}

/** Block a user from a room. The owner or a moderator may block; a block also
 *  hides that user's existing messages. Idempotent. */
export async function blockChatUser(
  params: { room: string; userId: string; byUserId: string },
  clock: Clock = systemClock,
  prisma: PrismaClient = defaultPrisma,
): Promise<void> {
  if (!(await canModerateRoom(params.room, params.byUserId, prisma))) {
    throw new ChatError('BLOCKED'); // neither the room owner nor a moderator
  }
  if (params.userId === params.room) return; // nobody can block the seller from their own room
  // Moderators can't turn on each other, and can't remove the owner's trust.
  if (params.userId !== params.byUserId && (await canModerateRoom(params.room, params.userId, prisma))) {
    if (params.byUserId !== params.room) return; // only the owner may block a fellow moderator
  }
  await prisma.chatBlock.upsert({
    where: { roomId_userId: { roomId: params.room, userId: params.userId } },
    create: { roomId: params.room, userId: params.userId },
    update: {},
  });
  await prisma.chatMessage.updateMany({
    where: { roomId: params.room, userId: params.userId, deletedAt: null },
    data: { deletedAt: clock.now() },
  });
}

/** The recent, non-deleted messages for a room, oldest→newest (chat reading order). */
export async function listRecentChat(
  room: string,
  limit = CHAT_BACKLOG,
  prisma: PrismaClient = defaultPrisma,
): Promise<PostedChat[]> {
  const rows = await prisma.chatMessage.findMany({
    where: { roomId: room, deletedAt: null },
    orderBy: { createdAt: 'desc' },
    take: limit,
    select: { id: true, roomId: true, userId: true, handle: true, text: true, createdAt: true },
  });
  // One extra lookup for the distinct senders rather than a per-row join: the
  // backlog is small and capped, and avatars must reflect the CURRENT user row.
  const senderIds = [...new Set(rows.map((r) => r.userId))];
  const avatars = new Map(
    (await prisma.user.findMany({ where: { id: { in: senderIds } }, select: { id: true, avatarUrl: true } })).map(
      (u) => [u.id, u.avatarUrl] as const,
    ),
  );
  return rows.reverse().map((r) => ({ ...r, avatarUrl: mediaUrl('avatar', r.userId, avatars.get(r.userId)) }));
}
