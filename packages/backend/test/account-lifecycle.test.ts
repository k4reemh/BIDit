import { describe, it, expect, beforeEach } from 'vitest';
import { prisma } from '../src/db.js';
import { registerWithEmail, loginWithEmail, banUser, unbanUser } from '../src/authz.js';
import { getOrCreateUserAccount, deposit } from '../src/ledger.js';
import { usdc } from '@bidit/shared';
import { resetDb } from './setup.js';

beforeEach(async () => {
  await resetDb();
});

/**
 * An unverified row is a half-finished signup, not an account. It used to squat
 * the email address forever: registering again was refused ("already
 * registered") and signing in only bounced you back to the verification screen,
 * so the address became permanently unusable.
 */
describe('re-registering over an unverified signup', () => {
  it('lets the same email sign up again and replaces the pending attempt', async () => {
    const email = 'pending@example.com';
    const first = await registerWithEmail({ email, password: 'firstpass1' });
    expect(first.emailVerified).toBe(false);

    const second = await registerWithEmail({ email, password: 'secondpass1' });
    expect(second.id).toBe(first.id); // reused the row, no duplicate account
    expect(await prisma.user.count({ where: { email } })).toBe(1);

    // The new password works and the abandoned one does not.
    expect(await loginWithEmail({ email, password: 'secondpass1' })).toBeTruthy();
    expect(await loginWithEmail({ email, password: 'firstpass1' })).toBeNull();
  });

  it('clears the old verification code so it cannot be replayed', async () => {
    const email = 'replay@example.com';
    const u = await registerWithEmail({ email, password: 'firstpass1' });
    await prisma.user.update({
      where: { id: u.id },
      data: { verifyCodeHash: 'stale', verifyCodeExpiresAt: new Date(Date.now() + 9e5), verifyAttempts: 3 },
    });
    await registerWithEmail({ email, password: 'secondpass1' });
    const row = await prisma.user.findUniqueOrThrow({ where: { id: u.id } });
    expect(row.verifyCodeHash).toBeNull();
    expect(row.verifyAttempts).toBe(0);
  });

  it('still refuses a VERIFIED email', async () => {
    const email = 'verified@example.com';
    const u = await registerWithEmail({ email, password: 'firstpass1' });
    await prisma.user.update({ where: { id: u.id }, data: { emailVerified: true } });
    await expect(registerWithEmail({ email, password: 'takeover1' })).rejects.toThrow(/already registered/);
    // The real owner's password is untouched.
    expect(await loginWithEmail({ email, password: 'firstpass1' })).toBeTruthy();
  });

  it('refuses to reuse a row that somehow holds value', async () => {
    const email = 'hasvalue@example.com';
    const u = await registerWithEmail({ email, password: 'firstpass1' });
    const accountId = await getOrCreateUserAccount(u.id, prisma);
    await deposit({ accountId, amount: usdc('10'), refId: 'seed-hasvalue' }, prisma);
    await expect(registerWithEmail({ email, password: 'takeover1' })).rejects.toThrow(/already registered/);
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
