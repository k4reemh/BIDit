import { describe, it, expect, beforeEach } from 'vitest';
import { createHmac } from 'node:crypto';
import { prisma } from '../src/db.js';
import { registerWithEmail, loginWithEmail, banUser, unbanUser } from '../src/authz.js';
import { requestPasswordReset, resetPassword } from '../src/password-reset.js';
import { getOrCreateUserAccount, deposit } from '../src/ledger.js';
import { usdc } from '@bidit/shared';
import { resetDb } from './setup.js';

beforeEach(async () => {
  await resetDb();
});

/**
 * One email, one row, no takeovers. An earlier iteration let a fresh signup
 * take over an unverified row; from the outside that looked exactly like
 * registering on top of someone's account and mailing yourself their code.
 * Refusal does not bring back the old lockout, because the owner of a pending
 * signup still has two ways in: their original password, or a password reset
 * whose emailed code doubles as verification.
 */
describe('signing up with an email that already has an account', () => {
  it('refuses whether the existing row is verified or not', async () => {
    const email = 'claimed@example.com';
    const first = await registerWithEmail({ email, password: 'firstpass1' });
    expect(first.emailVerified).toBe(false);

    // Unverified: refused. No password change, no fresh code, no new session.
    await expect(registerWithEmail({ email, password: 'takeover1' })).rejects.toThrow(/already registered/);
    expect(await loginWithEmail({ email, password: 'firstpass1' })).toBeTruthy();
    expect(await loginWithEmail({ email, password: 'takeover1' })).toBeNull();

    // Verified: refused the same way.
    await prisma.user.update({ where: { id: first.id }, data: { emailVerified: true } });
    await expect(registerWithEmail({ email, password: 'takeover1' })).rejects.toThrow(/already registered/);
    expect(await prisma.user.count({ where: { email } })).toBe(1);
  });

  it('leaves the pending-signup owner a way back in: password reset verifies too', async () => {
    // The refusal must not resurrect the old lockout, where an abandoned signup
    // made its address permanently unusable. The escape hatch is the reset
    // flow: the code lands in the real inbox, and reading it proves ownership,
    // so it both sets a new password and marks the email verified.
    const email = 'comeback@example.com';
    const u = await registerWithEmail({ email, password: 'forgotten1' });
    expect(u.emailVerified).toBe(false);

    await requestPasswordReset(email, prisma);
    const row = await prisma.user.findUniqueOrThrow({ where: { id: u.id } });
    expect(row.resetCodeHash).toBeTruthy();
    // The code is only ever stored as an HMAC, so recover it the way the
    // password-reset tests do: search the six-digit space.
    const secret = process.env.AUTH_SECRET ?? 'dev-secret';
    let code = '';
    for (let i = 0; i < 1_000_000; i++) {
      const c = String(i).padStart(6, '0');
      if (createHmac('sha256', secret).update(`reset:${c}`).digest('hex') === row.resetCodeHash) { code = c; break; }
    }
    expect(code).not.toBe('');
    await resetPassword({ email, code, password: 'recovered1' }, prisma);

    const after = await prisma.user.findUniqueOrThrow({ where: { id: u.id } });
    expect(after.emailVerified).toBe(true); // reset doubled as verification
    expect(await loginWithEmail({ email, password: 'recovered1' })).toBeTruthy();
  });
});

describe('admin ban', () => {
  it('blocks login, revokes sessions, and can be lifted', async () => {
    const email = 'banned@example.com';
    const u = await registerWithEmail({ email, password: 'goodpass1' });
    expect(await loginWithEmail({ email, password: 'goodpass1' })).toBeTruthy();

    await banUser(u.id, 'Scamming buyers', prisma);
    // Signing in is refused, and the reason reaches the person.
    await expect(loginWithEmail({ email, password: 'goodpass1' })).rejects.toThrow(/Scamming buyers/);
    // Tokens already out there die with the revocation epoch.
    expect((await prisma.user.findUniqueOrThrow({ where: { id: u.id } })).sessionsValidFrom).not.toBeNull();

    await unbanUser(u.id, prisma);
    expect(await loginWithEmail({ email, password: 'goodpass1' })).toBeTruthy();
  });

  it('leaves the ledger and orders intact, so a ban is reversible', async () => {
    const u = await registerWithEmail({ email: 'keepdata@example.com', password: 'goodpass1' });
    const accountId = await getOrCreateUserAccount(u.id, prisma);
    await deposit({ accountId, amount: usdc('25'), refId: 'seed-keepdata' }, prisma);
    await banUser(u.id, null, prisma);
    // Nothing was destroyed: in-flight escrow can still settle on a banned account.
    expect(await prisma.ledgerEntry.count({ where: { accountId } })).toBeGreaterThan(0);
  });

  it('will not ban an admin', async () => {
    const u = await registerWithEmail({ email: 'ops2@example.com', password: 'goodpass1' });
    await prisma.user.update({ where: { id: u.id }, data: { role: 'admin' } });
    await expect(banUser(u.id, null, prisma)).rejects.toThrow(/Admins cannot be banned/);
  });
});
