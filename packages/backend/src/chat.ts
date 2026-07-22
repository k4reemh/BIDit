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
import type { PrismaClient } from './db.js';
import { systemClock, type Clock } from './clock.js';

export const CHAT_MAX_LEN = 300;
export const CHAT_COOLDOWN_MS = 4000; // one message per user per 4s
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

  // DB-backed cooldown: the sender's most recent message in this room (deleted or
  // not — you can't delete your own, so this can't be gamed). Authoritative across
  // instances, unlike an in-memory timer.
  const last = await prisma.chatMessage.findFirst({
    where: { roomId: params.room, userId: params.userId },
    orderBy: { createdAt: 'desc' },
    select: { createdAt: true },
  });
  const now = clock.now();
  if (last) {
    const since = now.getTime() - last.createdAt.getTime();
    if (since < CHAT_COOLDOWN_MS) throw new ChatError('COOLDOWN', CHAT_COOLDOWN_MS - since);
  }

  const handle = (await prisma.user.findUnique({ where: { id: params.userId }, select: { handle: true } }))?.handle ?? 'someone';
  const row = await prisma.chatMessage.create({
    data: { roomId: params.room, userId: params.userId, handle, text, createdAt: now },
    select: { id: true, roomId: true, userId: true, handle: true, text: true, createdAt: true },
  });
  return row;
}

/** Seller deletes a message from their own room (soft delete). Only the room owner
 *  (byUserId === room) may delete. Returns true if a row was hidden. */
export async function deleteChatMessage(
  params: { room: string; messageId: string; byUserId: string },
  clock: Clock = systemClock,
  prisma: PrismaClient = defaultPrisma,
): Promise<boolean> {
  if (params.byUserId !== params.room) throw new ChatError('BLOCKED'); // not the room owner
  const res = await prisma.chatMessage.updateMany({
    where: { id: params.messageId, roomId: params.room, deletedAt: null },
    data: { deletedAt: clock.now() },
  });
  return res.count === 1;
}

/** Seller blocks a user from their own room. Only the room owner may block; a
 *  block also hides that user's existing messages. Idempotent. */
export async function blockChatUser(
  params: { room: string; userId: string; byUserId: string },
  clock: Clock = systemClock,
  prisma: PrismaClient = defaultPrisma,
): Promise<void> {
  if (params.byUserId !== params.room) throw new ChatError('BLOCKED'); // not the room owner
  if (params.userId === params.room) return; // a seller can't block themselves
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
  return rows.reverse();
}
