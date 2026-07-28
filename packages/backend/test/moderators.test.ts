import { describe, it, expect, beforeEach } from 'vitest';
import { prisma } from '../src/db.js';
import { registerWithEmail, setHandle, AuthError } from '../src/authz.js';
import {
  canModerateRoom,
  addRoomModerator,
  removeRoomModerator,
  listRoomModerators,
  postChatMessage,
  deleteChatMessage,
  blockChatUser,
  isChatBlocked,
  ModeratorError,
  ChatError,
} from '../src/chat.js';
import { resetDb } from './setup.js';

beforeEach(async () => {
  await resetDb();
});

let n = 0;
const user = async (handle: string) =>
  registerWithEmail({ email: `${handle}${n++}@example.com`, password: 'hunter2pw', handle });

describe('chat moderators', () => {
  it('lets the seller trust a moderator, who then gets the chat powers', async () => {
    const seller = await user('seller_a');
    const mod = await user('mod_a');
    const viewer = await user('viewer_a');

    expect(await canModerateRoom(seller.id, mod.id)).toBe(false);
    await addRoomModerator(seller.id, '@mod_a'); // an @ prefix is fine
    expect(await canModerateRoom(seller.id, mod.id)).toBe(true);

    // The moderator can now delete and block in that room.
    const msg = await postChatMessage({ room: seller.id, userId: viewer.id, text: 'spam spam' });
    expect(await deleteChatMessage({ room: seller.id, messageId: msg.id, byUserId: mod.id })).toBe(true);
    await blockChatUser({ room: seller.id, userId: viewer.id, byUserId: mod.id });
    expect(await isChatBlocked(seller.id, viewer.id)).toBe(true);
  });

  it('gives a moderator no power in anyone else’s room', async () => {
    const seller = await user('seller_b');
    const other = await user('seller_c');
    const mod = await user('mod_b');
    const viewer = await user('viewer_b');
    await addRoomModerator(seller.id, 'mod_b');

    expect(await canModerateRoom(other.id, mod.id)).toBe(false);
    const msg = await postChatMessage({ room: other.id, userId: viewer.id, text: 'hello' });
    await expect(
      deleteChatMessage({ room: other.id, messageId: msg.id, byUserId: mod.id }),
    ).rejects.toBeInstanceOf(ChatError);
  });

  it('an ordinary viewer still cannot moderate', async () => {
    const seller = await user('seller_d');
    const viewer = await user('viewer_d');
    const other = await user('viewer_e');
    const msg = await postChatMessage({ room: seller.id, userId: other.id, text: 'hi' });
    await expect(
      deleteChatMessage({ room: seller.id, messageId: msg.id, byUserId: viewer.id }),
    ).rejects.toBeInstanceOf(ChatError);
  });

  it('never lets the seller be blocked from their own room', async () => {
    const seller = await user('seller_e');
    const mod = await user('mod_e');
    await addRoomModerator(seller.id, 'mod_e');
    await blockChatUser({ room: seller.id, userId: seller.id, byUserId: mod.id });
    expect(await isChatBlocked(seller.id, seller.id)).toBe(false);
  });

  it('stops moderators blocking each other, but the seller still can', async () => {
    const seller = await user('seller_f');
    const modA = await user('mod_f1');
    const modB = await user('mod_f2');
    await addRoomModerator(seller.id, 'mod_f1');
    await addRoomModerator(seller.id, 'mod_f2');

    await blockChatUser({ room: seller.id, userId: modB.id, byUserId: modA.id });
    expect(await isChatBlocked(seller.id, modB.id)).toBe(false); // mod-on-mod is a no-op

    await blockChatUser({ room: seller.id, userId: modB.id, byUserId: seller.id });
    expect(await isChatBlocked(seller.id, modB.id)).toBe(true); // the owner decides
  });

  it('adding is idempotent, removing takes the power back', async () => {
    const seller = await user('seller_g');
    const mod = await user('mod_g');
    await addRoomModerator(seller.id, 'mod_g');
    await addRoomModerator(seller.id, 'mod_g');
    expect(await listRoomModerators(seller.id)).toHaveLength(1);

    await removeRoomModerator(seller.id, mod.id);
    expect(await canModerateRoom(seller.id, mod.id)).toBe(false);
    expect(await listRoomModerators(seller.id)).toHaveLength(0);
  });

  it('rejects an unknown username and the seller adding themselves', async () => {
    const seller = await user('seller_h');
    await expect(addRoomModerator(seller.id, 'nobody_here')).rejects.toBeInstanceOf(ModeratorError);
    await expect(addRoomModerator(seller.id, 'seller_h')).rejects.toBeInstanceOf(ModeratorError);
  });
});

describe('claiming a username mid-onboarding', () => {
  it('reports a clash immediately instead of at the end of the flow', async () => {
    await user('taken_one');
    const second = await user('someone_else');
    await expect(setHandle(second.id, 'taken_one')).rejects.toThrow(/taken/i);
  });

  it('takes a free username and lets you re-affirm your own', async () => {
    const u = await user('picker_one');
    const after = await setHandle(u.id, 'brand_new_name');
    expect(after.handle).toBe('brand_new_name');
    await expect(setHandle(u.id, 'brand_new_name')).resolves.toBeTruthy();
  });

  it('still enforces the username format', async () => {
    const u = await user('picker_two');
    await expect(setHandle(u.id, 'no')).rejects.toBeInstanceOf(AuthError);
    await expect(setHandle(u.id, 'bad spaces')).rejects.toBeInstanceOf(AuthError);
  });
});
