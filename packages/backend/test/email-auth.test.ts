import { describe, it, expect, beforeEach } from 'vitest';
import { prisma } from '../src/db.js';
import { registerWithEmail, loginWithEmail, completeOnboarding, AuthError } from '../src/authz.js';
import { issueSession, verifySession, hashPassword, verifyPassword } from '../src/auth.js';
import { resetDb } from './setup.js';

beforeEach(async () => {
  await resetDb();
});

describe('email sign-up persists a real account', () => {
  it('creates a user with a hashed password (never plaintext) + a ledger account', async () => {
    const user = await registerWithEmail({ email: 'Krispy@Example.com', password: 'hunter2pw', handle: 'krispyk4reem' });
    expect(user.email).toBe('krispy@example.com'); // normalized
    expect(user.handle).toBe('krispyk4reem');
    expect(user.passwordHash).toBeTruthy();
    expect(user.passwordHash).not.toContain('hunter2pw'); // hashed, not stored raw

    // the row is actually in Postgres
    const fromDb = await prisma.user.findUnique({ where: { email: 'krispy@example.com' } });
    expect(fromDb?.id).toBe(user.id);
    expect(await prisma.account.findUnique({ where: { userId: user.id } })).not.toBeNull();
  });

  it('logs in with the right password and rejects the wrong one', async () => {
    await registerWithEmail({ email: 'a@b.com', password: 'correct-horse', handle: 'collector1' });
    expect(await loginWithEmail({ email: 'a@b.com', password: 'correct-horse' })).not.toBeNull();
    expect(await loginWithEmail({ email: 'A@B.COM', password: 'correct-horse' })).not.toBeNull(); // case-insensitive
    expect(await loginWithEmail({ email: 'a@b.com', password: 'wrong' })).toBeNull();
    expect(await loginWithEmail({ email: 'nobody@b.com', password: 'correct-horse' })).toBeNull();
  });

  it('rejects duplicate email or handle and bad input', async () => {
    await registerWithEmail({ email: 'dup@b.com', password: 'password1', handle: 'taken_one' });
    await expect(registerWithEmail({ email: 'dup@b.com', password: 'password1', handle: 'other' })).rejects.toBeInstanceOf(AuthError);
    await expect(registerWithEmail({ email: 'new@b.com', password: 'password1', handle: 'taken_one' })).rejects.toBeInstanceOf(AuthError);
    await expect(registerWithEmail({ email: 'bad-email', password: 'password1', handle: 'fine_handle' })).rejects.toThrow(/valid email/);
    await expect(registerWithEmail({ email: 'ok@b.com', password: 'short12', handle: 'fine_handle' })).rejects.toThrow(/8 characters/);
    await expect(registerWithEmail({ email: 'ok@b.com', password: 'password1', handle: 'no' })).rejects.toThrow(/Handle/);
  });

  it('issues a session token that survives a round-trip (persisted login)', async () => {
    const user = await registerWithEmail({ email: 'sess@b.com', password: 'password1', handle: 'sessionuser' });
    const token = issueSession(user.id);
    expect(verifySession(token)).toBe(user.id); // re-opening the app restores the same user
    expect(verifySession(token + 'tamper')).toBeNull();
  });

  it('password hashing helpers are sound', () => {
    const stored = hashPassword('s3cret!');
    expect(verifyPassword('s3cret!', stored)).toBe(true);
    expect(verifyPassword('nope', stored)).toBe(false);
    expect(verifyPassword('x', null)).toBe(false);
  });
});

describe('onboarding', () => {
  it('sign-up without a handle gets a placeholder and is not onboarded', async () => {
    const user = await registerWithEmail({ email: 'new@b.com', password: 'password1' });
    expect(user.handle).toMatch(/^collector_/);
    expect(user.onboarded).toBe(false);
    expect(user.interests).toEqual([]);
  });

  it('completing onboarding saves the chosen username + interests and marks onboarded', async () => {
    const user = await registerWithEmail({ email: 'ob@b.com', password: 'password1' });
    const after = await completeOnboarding(user.id, {
      handle: 'AceCollector',
      displayName: 'Ace',
      interests: ['one-piece', 'pokemon', 7 as unknown as string],
    });
    expect(after.handle).toBe('acecollector'); // normalized
    expect(after.displayName).toBe('Ace');
    expect(after.interests).toEqual(['one-piece', 'pokemon']); // non-strings dropped
    expect(after.onboarded).toBe(true);

    const fromDb = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(fromDb.onboarded).toBe(true);
    expect(fromDb.interests).toEqual(['one-piece', 'pokemon']);
  });

  it('rejects an already-taken username during onboarding', async () => {
    await registerWithEmail({ email: 'one@b.com', password: 'password1', handle: 'wanted' });
    const two = await registerWithEmail({ email: 'two@b.com', password: 'password1' });
    await expect(completeOnboarding(two.id, { handle: 'wanted' })).rejects.toBeInstanceOf(AuthError);
  });

  it('lets a user keep their own handle while onboarding', async () => {
    const user = await registerWithEmail({ email: 'keep@b.com', password: 'password1', handle: 'mine_already' });
    const after = await completeOnboarding(user.id, { handle: 'mine_already', interests: ['slabs'] });
    expect(after.handle).toBe('mine_already');
    expect(after.onboarded).toBe(true);
  });
});
