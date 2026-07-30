import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { prisma } from '../src/db.js';
import { registerWithEmail, AuthError, findOrCreateByWallet, isAdmin } from '../src/authz.js';
import {
  sendVerificationCode,
  verifyEmailCode,
  backfillLegacyVerified,
  requireVerifiedEmail,
  EmailUnverifiedError,
  MAX_ATTEMPTS,
  CODE_TTL_MS,
  RESEND_COOLDOWN_MS,
} from '../src/email-verify.js';
import { resetDb } from './setup.js';

beforeEach(async () => {
  await resetDb();
});

/** Register + issue a code, returning the user id. The code itself is never
 *  readable (only its HMAC is stored), so tests brute-force the 6-digit space
 *  against `verifyEmailCode` only where they must: otherwise they assert on
 *  behaviour that doesn't need the plaintext. */
async function newUnverified(email = 'buyer@example.com') {
  const user = await registerWithEmail({ email, password: 'hunter2pw' });
  await sendVerificationCode(user.id, { force: true });
  return user.id;
}

describe('email verification', () => {
  it('a fresh email signup starts unverified with a pending code', async () => {
    const userId = await newUnverified();
    const row = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(row.emailVerified).toBe(false);
    expect(row.verifyCodeHash).toBeTruthy();
    expect(row.verifyCodeExpiresAt).toBeTruthy();
    expect(row.verifyAttempts).toBe(0);
  });

  it('never stores the code itself, only a hash of it', async () => {
    const userId = await newUnverified();
    const row = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    // A stored 6-digit code would be exactly 6 digits; the hash is 64 hex chars.
    expect(row.verifyCodeHash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.verifyCodeHash).not.toMatch(/^\d{6}$/);
  });

  it('accepts the right code and clears it so it cannot be replayed', async () => {
    const userId = await newUnverified();
    const { verifyCodeHash } = await prisma.user.findUniqueOrThrow({ where: { id: userId } });

    // Find the code that produced this hash (the test knows the search space).
    const { createHmac } = await import('node:crypto');
    const secret = process.env.AUTH_SECRET ?? 'dev-secret';
    let code = '';
    for (let i = 0; i < 1_000_000; i++) {
      const candidate = String(i).padStart(6, '0');
      if (createHmac('sha256', secret).update(candidate).digest('hex') === verifyCodeHash) {
        code = candidate;
        break;
      }
    }
    expect(code).not.toBe('');

    await verifyEmailCode(userId, code);
    const after = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(after.emailVerified).toBe(true);
    expect(after.verifyCodeHash).toBeNull();
    expect(after.verifyCodeExpiresAt).toBeNull();

    // Replaying the same code is a no-op, not a second "verification".
    await expect(verifyEmailCode(userId, code)).resolves.toBeUndefined();
  });

  it('a wrong code costs an attempt and dies at the cap', async () => {
    const userId = await newUnverified();
    for (let i = 1; i <= MAX_ATTEMPTS; i++) {
      // '000000' is wrong for all but 1-in-a-million runs; re-issue if unlucky.
      await expect(verifyEmailCode(userId, '999999')).rejects.toBeInstanceOf(AuthError);
      const row = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
      expect(row.verifyAttempts).toBe(i);
      expect(row.emailVerified).toBe(false);
    }
    // Cap reached: even a further guess is refused outright.
    await expect(verifyEmailCode(userId, '123456')).rejects.toThrow(/Too many wrong codes/);
  });

  it('refuses an expired code', async () => {
    const userId = await newUnverified();
    const future = new Date(Date.now() + CODE_TTL_MS + 1000);
    await expect(verifyEmailCode(userId, '123456', prisma, future)).rejects.toThrow(/expired/);
  });

  it('rate-limits resends but lets a forced send through', async () => {
    const userId = await newUnverified();
    await expect(sendVerificationCode(userId)).rejects.toThrow(/just sent/);
    // Past the cooldown it is allowed again, and the code rotates.
    const before = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    const later = new Date(Date.now() + RESEND_COOLDOWN_MS + 1000);
    await sendVerificationCode(userId, {}, prisma, later);
    const after = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(after.verifyCodeHash).not.toBe(before.verifyCodeHash);
  });

  it('a new code resets the attempt counter', async () => {
    const userId = await newUnverified();
    await expect(verifyEmailCode(userId, '999999')).rejects.toBeInstanceOf(AuthError);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: userId } })).verifyAttempts).toBe(1);
    await sendVerificationCode(userId, { force: true });
    expect((await prisma.user.findUniqueOrThrow({ where: { id: userId } })).verifyAttempts).toBe(0);
  });
});

describe('the gate', () => {
  it('blocks an account with an unconfirmed email', async () => {
    const userId = await newUnverified();
    await expect(requireVerifiedEmail(userId)).rejects.toBeInstanceOf(EmailUnverifiedError);
  });

  it('never blocks a wallet account, which has no email to confirm', async () => {
    const user = await findOrCreateByWallet('So11111111111111111111111111111111111111112');
    await expect(requireVerifiedEmail(user.id)).resolves.toBeUndefined();
  });
});

describe('legacy backfill', () => {
  it('verifies pre-existing accounts but leaves a signup mid-flow alone', async () => {
    // An account from before the feature: has an email, no pending code.
    const legacy = await registerWithEmail({ email: 'old@example.com', password: 'hunter2pw' });
    const pending = await newUnverified('new@example.com');

    const count = await backfillLegacyVerified();
    expect(count).toBe(1);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: legacy.id } })).emailVerified).toBe(true);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: pending } })).emailVerified).toBe(false);

    // Idempotent: running it again changes nothing.
    expect(await backfillLegacyVerified()).toBe(0);
  });
});

/**
 * The allowlist matches on an email ADDRESS, so the account has to have proven it
 * owns that address. Otherwise an allowlisted address with no account yet could
 * simply be registered by anyone, handing them escrow release/refund and every
 * buyer's home address. Registration's distinct "already registered" error makes
 * finding an unclaimed one easy.
 */
describe('admin requires a verified email (SEC-6)', () => {
  const ADMIN = 'ops@bidit.test';
  beforeEach(() => { process.env.BIDIT_ADMIN_EMAILS = ADMIN; });
  afterEach(() => { delete process.env.BIDIT_ADMIN_EMAILS; });

  it('does not grant admin to an unverified allowlisted address', async () => {
    const attacker = await registerWithEmail({ email: ADMIN, password: 'hunter2pw' });
    expect(await isAdmin(attacker.id)).toBe(false);
  });

  it('grants it once the address is actually confirmed', async () => {
    const owner = await registerWithEmail({ email: ADMIN, password: 'hunter2pw' });
    expect(await isAdmin(owner.id)).toBe(false);
    await prisma.user.update({ where: { id: owner.id }, data: { emailVerified: true } });
    expect(await isAdmin(owner.id)).toBe(true);
  });

  it('leaves a genuine role=admin account alone', async () => {
    const u = await registerWithEmail({ email: 'staff@bidit.test', password: 'hunter2pw' });
    await prisma.user.update({ where: { id: u.id }, data: { role: 'admin' } });
    expect(await isAdmin(u.id)).toBe(true); // role, not the allowlist
  });
});
