/**
 * "Forgot my password": a short numeric code, mailed to the address on the
 * account, that authorizes setting a new password.
 *
 * Two properties matter beyond the usual code hygiene (HMAC-stored, expiring,
 * attempt-capped, resend-throttled, same shape as email-verify.ts):
 *
 *  1. Requesting a reset NEVER reveals whether an email is registered. The
 *     endpoint answers the same either way, so this can't be used to enumerate
 *     users: worth caring about on a marketplace holding real balances.
 *  2. A completed reset revokes every existing session. If the reason for the
 *     reset was a compromised account, the attacker's token dies with it.
 */
import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';
import { prisma as defaultPrisma, type PrismaClient } from './db.js';
import { sendEmail, emailShell, paragraph } from './email.js';
import { AuthError, revokeUserSessions } from './authz.js';
import { hashPassword, MAX_PASSWORD_LEN } from './auth.js';

export const RESET_TTL_MS = 15 * 60_000;
export const MAX_RESET_ATTEMPTS = 6;
export const RESET_RESEND_COOLDOWN_MS = 60_000;
export const MIN_PASSWORD_LEN = 8;

const newCode = (): string => String(randomInt(0, 1_000_000)).padStart(6, '0');

const hashCode = (code: string): string =>
  createHmac('sha256', process.env.AUTH_SECRET ?? 'dev-secret').update(`reset:${code}`).digest('hex');

const codeMatches = (code: string, hash: string): boolean => {
  const a = Buffer.from(hashCode(code), 'hex');
  const b = Buffer.from(hash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
};

const normEmail = (e: string) => e.trim().toLowerCase();

/**
 * Start a reset. Resolves regardless of whether the email exists: the caller
 * must answer identically either way. Returns true only so tests can assert a
 * mail actually went out.
 */
export async function requestPasswordReset(
  rawEmail: string,
  prisma: PrismaClient = defaultPrisma,
  now: Date = new Date(),
): Promise<boolean> {
  const email = normEmail(rawEmail);
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user || !user.passwordHash) return false; // unknown, or a wallet-only account
  if (
    user.resetCodeSentAt &&
    now.getTime() - user.resetCodeSentAt.getTime() < RESET_RESEND_COOLDOWN_MS
  ) {
    return false; // silently throttled: telling the caller would leak existence
  }

  const code = newCode();
  await prisma.user.update({
    where: { id: user.id },
    data: {
      resetCodeHash: hashCode(code),
      resetCodeExpiresAt: new Date(now.getTime() + RESET_TTL_MS),
      resetCodeSentAt: now,
      resetAttempts: 0,
    },
  });

  await sendEmail({
    to: email,
    sensitive: true, // the code is in the subject: keep it out of the logs
    subject: `${code} is your BIDit password reset code`,
    html: emailShell(
      'Reset your password',
      paragraph('Enter this code in BIDit to set a new password:') +
        `<div style="font-size:30px;font-weight:800;letter-spacing:.16em;margin:14px 0">${code}</div>` +
        paragraph(
          'It expires in 15 minutes. If you didn’t ask to reset your password, ignore this email and nothing changes.',
        ),
    ),
  });
  return true;
}

/**
 * Finish a reset: check the code, set the new password, and drop every existing
 * session. Errors here are deliberately generic about the account's existence.
 */
export async function resetPassword(
  input: { email: string; code: string; password: string },
  prisma: PrismaClient = defaultPrisma,
  now: Date = new Date(),
): Promise<void> {
  if (input.password.length < MIN_PASSWORD_LEN) {
    throw new AuthError(`Password must be at least ${MIN_PASSWORD_LEN} characters.`);
  }
  if (input.password.length > MAX_PASSWORD_LEN) {
    throw new AuthError(`Password must be at most ${MAX_PASSWORD_LEN} characters.`);
  }

  const email = normEmail(input.email);
  const user = await prisma.user.findUnique({ where: { email } });
  // Same message for "no such account" and "no code pending", so a failed
  // attempt says nothing about whether the address is registered.
  const generic = 'That code is wrong or has expired. Request a new one.';
  if (!user || !user.resetCodeHash || !user.resetCodeExpiresAt) throw new AuthError(generic);
  if (now > user.resetCodeExpiresAt) throw new AuthError(generic);

  // Spend one attempt BEFORE looking at the code, in a single conditional write.
  // Read-then-write was a lost update: fire the guesses concurrently and they all
  // read the same count, so the cap never tripped and six digits fell in seconds.
  // updateMany's WHERE re-evaluates per row under the row lock, so exactly
  // MAX_RESET_ATTEMPTS of them can ever succeed however they interleave.
  const claimed = await prisma.user.updateMany({
    where: { id: user.id, resetAttempts: { lt: MAX_RESET_ATTEMPTS } },
    data: { resetAttempts: { increment: 1 } },
  });
  if (claimed.count === 0) throw new AuthError('Too many wrong codes. Request a new one.');

  const submitted = String(input.code ?? '').replace(/\D/g, '');
  if (submitted.length !== 6 || !codeMatches(submitted, user.resetCodeHash)) {
    throw new AuthError(generic);
  }

  await prisma.user.update({
    where: { id: user.id },
    data: {
      passwordHash: await hashPassword(input.password),
      resetCodeHash: null,
      resetCodeExpiresAt: null,
      resetAttempts: 0,
      // Whoever reset it proved they read the account's email, so the address is
      // theirs; a reset doubles as verification.
      emailVerified: true,
    },
  });

  // Anything issued before now is dead, including an attacker's stolen token.
  await revokeUserSessions(user.id, prisma);
}
