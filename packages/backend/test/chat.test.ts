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

  it('honors the seller’s per-room cooldown (0 = off)', async () => {
    const seller = await makeUser('seller');
    await prisma.sellerProfile.create({ data: { userId: seller.userId, chatCooldownMs: 0 } });
    const u = await makeUser('buyer');
    const clock = new ManualClock(T0);
    // Cooldown off → two messages back-to-back both go through.
    await postChatMessage({ room: seller.userId, userId: u.userId, text: 'a' }, clock, prisma);
    const b = await postChatMessage({ room: seller.userId, userId: u.userId, text: 'b' }, clock, prisma);
    expect(b.text).toBe('b');
  });

  it('honors a custom per-room cooldown longer than the default', async () => {
    const seller = await makeUser('seller');
    await prisma.sellerProfile.create({ data: { userId: seller.userId, chatCooldownMs: 10000 } });
    const u = await makeUser('buyer');
    const clock = new ManualClock(T0);
    await postChatMessage({ room: seller.userId, userId: u.userId, text: 'first' }, clock, prisma);
    clock.advance(CHAT_COOLDOWN_MS); // past the default, but not the 10s custom value
    await expect(postChatMessage({ room: seller.userId, userId: u.userId, text: 'too soon' }, clock, prisma)).rejects.toThrow(/COOLDOWN/);
    clock.advance(10000 - CHAT_COOLDOWN_MS);
    const ok = await postChatMessage({ room: seller.userId, userId: u.userId, text: 'now ok' }, clock, prisma);
    expect(ok.text).toBe('now ok');
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

describe('tiers + replies', () => {
  it('snapshots the sender points tier on the message', async () => {
    const clock = new ManualClock(T0);
    const room = (await makeUser('seller')).userId;
    const pleb = await makeUser('buyer');
    const whale = await makeUser('buyer');
    await prisma.user.update({ where: { id: whale.userId }, data: { points: 60_000n } });

    const m1 = await postChatMessage({ room, userId: pleb.userId, text: 'gm' }, clock, prisma);
    expect(m1.tier).toBeNull();
    const m2 = await postChatMessage({ room, userId: whale.userId, text: 'gm gold' }, clock, prisma);
    expect(m2.tier).toBe('gold');

    // Snapshot: later point gains do not rewrite old lines.
    await prisma.user.update({ where: { id: whale.userId }, data: { points: 2_000_000n } });
    const history = await listRecentChat(room, 10, prisma);
    expect(history.find((h) => h.id === m2.id)!.tier).toBe('gold');
    const m3 = await postChatMessage({ room, userId: whale.userId, text: 'gm legend' }, new ManualClock(T0 + 10_000), prisma);
    expect(m3.tier).toBe('legend');
  });

  it('replies snapshot the parent and survive its deletion; bad parents degrade', async () => {
    const clock = new ManualClock(T0);
    const seller = await makeUser('seller');
    const room = seller.userId;
    const a = await makeUser('buyer');
    const b = await makeUser('buyer');

    const parent = await postChatMessage({ room, userId: a.userId, text: 'W pull or nah?' }, clock, prisma);
    const reply = await postChatMessage(
      { room, userId: b.userId, text: 'Huge W', replyToId: parent.id },
      new ManualClock(T0 + 10_000),
      prisma,
    );
    expect(reply.replyTo).toEqual({ id: parent.id, handle: parent.handle, text: 'W pull or nah?' });

    // The quote survives the parent being moderated away.
    await deleteChatMessage({ room, messageId: parent.id, byUserId: room }, new ManualClock(T0 + 20_000), prisma);
    const history = await listRecentChat(room, 10, prisma);
    const kept = history.find((h) => h.id === reply.id)!;
    expect(kept.replyTo?.text).toBe('W pull or nah?');

    // Unknown parent / wrong room / already-deleted parent: plain message, no throw.
    const other = await makeUser('seller');
    const cross = await postChatMessage(
      { room: other.userId, userId: b.userId, text: 'hi', replyToId: parent.id },
      new ManualClock(T0 + 30_000),
      prisma,
    );
    expect(cross.replyTo).toBeNull();
    const dead = await postChatMessage(
      { room, userId: a.userId, text: 'late', replyToId: parent.id },
      new ManualClock(T0 + 40_000),
      prisma,
    );
    expect(dead.replyTo).toBeNull();
  });
});
