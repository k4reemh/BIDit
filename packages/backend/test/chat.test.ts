import { describe, it, expect, beforeEach } from 'vitest';
import { prisma } from '../src/db.js';
import { ManualClock } from '../src/clock.js';
import {
  postChatMessage,
  deleteChatMessage,
  blockChatUser,
  listRecentChat,
  isChatBlocked,
  sanitizeChatText,
  ChatError,
  CHAT_COOLDOWN_MS,
} from '../src/chat.js';
import { resetDb, makeUser } from './setup.js';

const T0 = new Date('2026-01-01T00:00:00.000Z').getTime();

beforeEach(async () => {
  await resetDb();
});

describe('sanitizeChatText', () => {
  it('strips control chars + collapses whitespace', () => {
    expect(sanitizeChatText('  hi\n\tthere  ')).toBe('hi there');
  });
  it('rejects empty and over-long', () => {
    expect(() => sanitizeChatText('   ')).toThrow(/EMPTY/);
    expect(() => sanitizeChatText('x'.repeat(400))).toThrow(/TOO_LONG/);
  });
});

describe('postChatMessage', () => {
  it('persists a message and returns the sender handle', async () => {
    const seller = await makeUser('seller');
    const u = await makeUser('buyer');
    const m = await postChatMessage({ room: seller.userId, userId: u.userId, text: 'can you bid the art?' }, new ManualClock(T0), prisma);
    expect(m.handle).toBe(u.handle);
    expect(m.text).toBe('can you bid the art?');
    expect(await prisma.chatMessage.count({ where: { roomId: seller.userId } })).toBe(1);
  });

  it('enforces a per-user cooldown, then allows after it passes', async () => {
    const seller = await makeUser('seller');
    const u = await makeUser('buyer');
    const clock = new ManualClock(T0);
    await postChatMessage({ room: seller.userId, userId: u.userId, text: 'first' }, clock, prisma);
    await expect(postChatMessage({ room: seller.userId, userId: u.userId, text: 'spam' }, clock, prisma)).rejects.toThrow(/COOLDOWN/);
    clock.advance(CHAT_COOLDOWN_MS);
    const ok = await postChatMessage({ room: seller.userId, userId: u.userId, text: 'second' }, clock, prisma);
    expect(ok.text).toBe('second');
  });

  it('rejects a blocked user', async () => {
    const seller = await makeUser('seller');
    const u = await makeUser('buyer');
    const clock = new ManualClock(T0);
    await blockChatUser({ room: seller.userId, userId: u.userId, byUserId: seller.userId }, clock, prisma);
    expect(await isChatBlocked(seller.userId, u.userId, prisma)).toBe(true);
    await expect(postChatMessage({ room: seller.userId, userId: u.userId, text: 'hi' }, clock, prisma)).rejects.toThrow(/BLOCKED/);
  });
});

describe('history + moderation', () => {
  it('listRecentChat returns the last N chronological, excluding deleted', async () => {
    const seller = await makeUser('seller');
    const clock = new ManualClock(T0);
    const ids: string[] = [];
    for (let i = 0; i < 12; i++) {
      const u = await makeUser('buyer'); // fresh sender each time (cooldown is per-user)
      const m = await postChatMessage({ room: seller.userId, userId: u.userId, text: `m${i}` }, clock, prisma);
      ids.push(m.id);
      clock.advance(1000);
    }
    const recent = await listRecentChat(seller.userId, 10, prisma);
    expect(recent.map((m) => m.text)).toEqual(['m2', 'm3', 'm4', 'm5', 'm6', 'm7', 'm8', 'm9', 'm10', 'm11']);

    await deleteChatMessage({ room: seller.userId, messageId: ids[11]!, byUserId: seller.userId }, clock, prisma);
    const after = await listRecentChat(seller.userId, 10, prisma);
    expect(after.find((m) => m.text === 'm11')).toBeUndefined();
  });

  it('only the room owner can delete or block', async () => {
    const seller = await makeUser('seller');
    const stranger = await makeUser('buyer');
    const u = await makeUser('buyer');
    const clock = new ManualClock(T0);
    const m = await postChatMessage({ room: seller.userId, userId: u.userId, text: 'hi' }, clock, prisma);
    await expect(deleteChatMessage({ room: seller.userId, messageId: m.id, byUserId: stranger.userId }, clock, prisma)).rejects.toThrow();
    await expect(blockChatUser({ room: seller.userId, userId: u.userId, byUserId: stranger.userId }, clock, prisma)).rejects.toThrow();
    expect(await deleteChatMessage({ room: seller.userId, messageId: m.id, byUserId: seller.userId }, clock, prisma)).toBe(true);
  });

  it('blocking a user also hides their existing messages', async () => {
    const seller = await makeUser('seller');
    const u = await makeUser('buyer');
    const clock = new ManualClock(T0);
    await postChatMessage({ room: seller.userId, userId: u.userId, text: 'spam' }, clock, prisma);
    await blockChatUser({ room: seller.userId, userId: u.userId, byUserId: seller.userId }, clock, prisma);
    expect((await listRecentChat(seller.userId, 10, prisma)).length).toBe(0);
  });
});
