/**
 * Email ownership check: we mail a short numeric code and the account stays
 * unverified until it comes back.
 *
 * The code is never stored — only an HMAC of it under AUTH_SECRET — so a leaked
 * database row can't be replayed into someone's account. Three limits bound the
 * obvious attacks: the code expires, wrong guesses are capped (a 6-digit code is
 * only 10^6 wide, so unlimited guessing would fall in hours), and resends have a
 * cooldown so the endpoint can't be used to spam someone's inbox.
 */
import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';
import { prisma as defaultPrisma, type PrismaClient } from './db.js';
import { sendEmail, emailShell, paragraph } from './email.js';
import { AuthError } from './authz.js';

export const CODE_TTL_MS = 15 * 60_000;
export const MAX_ATTEMPTS = 6;
export const RESEND_COOLDOWN_MS = 60_000;

/** Six digits, uniformly random (randomInt is rejection-sampled, not modulo-biased). */
const newCode = (): string => String(randomInt(0, 1_000_000)).padStart(6, '0');

const hashCode = (code: string): string =>
  createHmac('sha256', process.env.AUTH_SECRET ?? 'dev-secret').update(code).digest('hex');

const codeMatches = (code: string, hash: string): boolean => {
  const a = Buffer.from(hashCode(code), 'hex');
  const b = Buffer.from(hash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
};

/** Issue a fresh code, mail it, and reset the attempt counter. Throws if the
 *  caller is resending faster than the cooldown allows. */
export async function sendVerificationCode(
  userId: string,
  opts: { force?: boolean } = {},
  prisma: PrismaClient = defaultPrisma,
  now: Date = new Date(),
): Promise<void> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw new AuthError('Account not found.');
  if (!user.email) throw new AuthError('This account has no email address.');
  if (user.emailVerified) throw new AuthError('That email is already verified.');
  if (
    !opts.force &&
    user.verifyCodeSentAt &&
    now.getTime() - user.verifyCodeSentAt.getTime() < RESEND_COOLDOWN_MS
  ) {
    throw new AuthError('A code was just sent. Check your inbox, then try again in a minute.');
  }

  const code = newCode();
  await prisma.user.update({
    where: { id: userId },
    data: {
      verifyCodeHash: hashCode(code),
      verifyCodeExpiresAt: new Date(now.getTime() + CODE_TTL_MS),
      verifyCodeSentAt: now,
      verifyAttempts: 0,
    },
  });

  await sendEmail({
    to: user.email,
    subject: `${code} is your BIDit verification code`,
    html: emailShell(
      'Confirm your email',
      paragraph('Enter this code to finish setting up your BIDit account:') +
        `<div style="font-size:30px;font-weight:800;letter-spacing:.16em;margin:14px 0">${code}</div>` +
        paragraph('It expires in 15 minutes. If you didn’t sign up for BIDit, ignore this email.'),
    ),
  });
}

/** Check a submitted code. Returns on success; throws AuthError otherwise.
 *  A wrong guess costs an attempt; the code dies at MAX_ATTEMPTS. */
export async function verifyEmailCode(
  userId: string,
  code: string,
  prisma: PrismaClient = defaultPrisma,
  now: Date = new Date(),
): Promise<void> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw new AuthError('Account not found.');
  if (user.emailVerified) return; // already done — treat as success, not an error
  if (!user.verifyCodeHash || !user.verifyCodeExpiresAt) {
    throw new AuthError('No code is pending. Request a new one.');
  }
  if (user.verifyAttempts >= MAX_ATTEMPTS) {
    throw new AuthError('Too many wrong codes. Request a new one.');
  }
  if (now > user.verifyCodeExpiresAt) {
    throw new AuthError('That code expired. Request a new one.');
  }

  const submitted = String(code ?? '').replace(/\D/g, '');
  if (submitted.length !== 6 || !codeMatches(submitted, user.verifyCodeHash)) {
    const attempts = user.verifyAttempts + 1;
    await prisma.user.update({ where: { id: userId }, data: { verifyAttempts: attempts } });
    throw new AuthError(
      attempts >= MAX_ATTEMPTS
        ? 'That code is wrong, and it was the last try. Request a new one.'
        : 'That code is wrong. Check the email and try again.',
    );
  }

  // Clear the code so it can't be replayed and the boot backfill skips this row.
  await prisma.user.update({
    where: { id: userId },
    data: {
      emailVerified: true,
      verifyCodeHash: null,
      verifyCodeExpiresAt: null,
      verifyAttempts: 0,
    },
  });
}

/**
 * One-time backfill for accounts created before email verification existed:
 * mark them verified so nobody who already signed up gets locked out. Safe to
 * run on every boot — a row with a pending code is a NEW signup mid-flow, and
 * the `verifyCodeHash: null` guard leaves it alone.
 */
export async function backfillLegacyVerified(prisma: PrismaClient = defaultPrisma): Promise<number> {
  const { count } = await prisma.user.updateMany({
    where: { emailVerified: false, verifyCodeHash: null, email: { not: null } },
    data: { emailVerified: true },
  });
  return count;
}

/** Thrown by the gate below. Carries a code so the web can pop the
 *  verification step instead of showing a generic error. */
export class EmailUnverifiedError extends Error {
  readonly status = 403;
  readonly code = 'EMAIL_UNVERIFIED';
  constructor(message = 'Confirm your email address to continue.') {
    super(message);
    this.name = 'EmailUnverifiedError';
  }
}

/**
 * Gate for actions that move money or create obligations. Only accounts that
 * HAVE an email must verify it: wallet logins proved ownership by signing, and
 * dev/seed users have no address to confirm.
 */
export async function requireVerifiedEmail(
  userId: string,
  prisma: PrismaClient = defaultPrisma,
): Promise<void> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { email: true, emailVerified: true },
  });
  if (user?.email && !user.emailVerified) throw new EmailUnverifiedError();
}
