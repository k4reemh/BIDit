import { describe, it, expect, beforeEach } from 'vitest';
import { createHmac } from 'node:crypto';
import { prisma } from '../src/db.js';
import { registerWithEmail, loginWithEmail, AuthError } from '../src/authz.js';
import { issueSession, verifySession } from '../src/auth.js';
import {
  requestPasswordReset,
  resetPassword,
  RESET_TTL_MS,
  RESET_RESEND_COOLDOWN_MS,
  MAX_RESET_ATTEMPTS,
} from '../src/password-reset.js';
import { resetDb } from './setup.js';

beforeEach(async () => {
  await resetDb();
});

/** The code is only stored as an HMAC, so tests recover it the same way the
 *  email-verification tests do: search the (small) 6-digit space. */
async function codeFor(email: string): Promise<string> {
  const u = await prisma.user.findUniqueOrThrow({ where: { email } });
  const secret = process.env.AUTH_SECRET ?? 'dev-secret';
  for (let i = 0; i < 1_000_000; i++) {
    const c = String(i).padStart(6, '0');
    if (createHmac('sha256', secret).update(`reset:${c}`).digest('hex') === u.resetCodeHash) return c;
  }
  throw new Error('code not found');
}

describe('forgot password', () => {
  it('resets the password with a mailed code and lets the new one sign in', async () => {
    const email = 'reset@example.com';
    await registerWithEmail({ email, password: 'oldpassword1' });
    expect(await requestPasswordReset(email)).toBe(true);

    await resetPassword({ email, code: await codeFor(email), password: 'brandnewpass1' });

    expect(await loginWithEmail({ email, password: 'brandnewpass1' })).toBeTruthy();
    expect(await loginWithEmail({ email, password: 'oldpassword1' })).toBeNull(); // the old one is dead
  });

  it('never stores the code itself', async () => {
    const email = 'hash@example.com';
    await registerWithEmail({ email, password: 'oldpassword1' });
    await requestPasswordReset(email);
    const u = await prisma.user.findUniqueOrThrow({ where: { email } });
    expect(u.resetCodeHash).toMatch(/^[0-9a-f]{64}$/);
    expect(u.resetCodeHash).not.toMatch(/^\d{6}$/);
  });

  it('says nothing about whether an email is registered', async () => {
    // An unknown address resolves exactly like a throttled known one: false,
    // no throw. The endpoint answers 200 either way (see dev-server).
    await expect(requestPasswordReset('nobody@example.com')).resolves.toBe(false);
  });

  it('signs every existing session out, killing a stolen token', async () => {
    const email = 'revoke@example.com';
    const user = await registerWithEmail({ email, password: 'oldpassword1' });
    const stolen = issueSession(user.id);
    expect(verifySession(stolen)).toBe(user.id);

    await requestPasswordReset(email);
    await resetPassword({ email, code: await codeFor(email), password: 'brandnewpass1' });

    expect(verifySession(stolen)).toBeNull();
  });

  it('refuses a wrong code, an expired one, and too many tries', async () => {
    const email = 'wrong@example.com';
    await registerWithEmail({ email, password: 'oldpassword1' });
    await requestPasswordReset(email);

    await expect(
      resetPassword({ email, code: '999999', password: 'brandnewpass1' }),
    ).rejects.toBeInstanceOf(AuthError);

    const real = await codeFor(email);
    const expired = new Date(Date.now() + RESET_TTL_MS + 1000);
    await expect(
      resetPassword({ email, code: real, password: 'brandnewpass1' }, prisma, expired),
    ).rejects.toThrow(/wrong or has expired/);

    for (let i = 1; i < MAX_RESET_ATTEMPTS; i++) {
      await expect(resetPassword({ email, code: '999999', password: 'brandnewpass1' })).rejects.toThrow();
    }
    // Cap reached: even the correct code is refused now.
    await expect(resetPassword({ email, code: real, password: 'brandnewpass1' })).rejects.toThrow(/Too many/);
  });

  it('rejects a too-short new password before touching the account', async () => {
    const email = 'shortpw@example.com';
    await registerWithEmail({ email, password: 'oldpassword1' });
    await requestPasswordReset(email);
    await expect(
      resetPassword({ email, code: await codeFor(email), password: 'short' }),
    ).rejects.toThrow(/at least 8/);
    expect(await loginWithEmail({ email, password: 'oldpassword1' })).toBeTruthy(); // unchanged
  });

  it('throttles resends, then rotates the code once the cooldown passes', async () => {
    const email = 'throttle@example.com';
    await registerWithEmail({ email, password: 'oldpassword1' });
    expect(await requestPasswordReset(email)).toBe(true);
    expect(await requestPasswordReset(email)).toBe(false); // too soon

    const before = (await prisma.user.findUniqueOrThrow({ where: { email } })).resetCodeHash;
    const later = new Date(Date.now() + RESET_RESEND_COOLDOWN_MS + 1000);
    expect(await requestPasswordReset(email, prisma, later)).toBe(true);
    const after = (await prisma.user.findUniqueOrThrow({ where: { email } })).resetCodeHash;
    expect(after).not.toBe(before);
  });

  it('clears the code so it cannot be replayed', async () => {
    const email = 'replay@example.com';
    await registerWithEmail({ email, password: 'oldpassword1' });
    await requestPasswordReset(email);
    const code = await codeFor(email);
    await resetPassword({ email, code, password: 'brandnewpass1' });
    await expect(resetPassword({ email, code, password: 'thirdpassword1' })).rejects.toThrow();
    expect(await loginWithEmail({ email, password: 'brandnewpass1' })).toBeTruthy();
  });
});
