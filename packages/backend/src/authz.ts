/** User resolution + authorization gates. */
import { randomBytes } from 'node:crypto';
import { Role } from '@bidit/shared';
import { Prisma, type User } from '@prisma/client';
import { prisma as defaultPrisma } from './db.js';
import type { PrismaClient } from './db.js';
import { getOrCreateUserAccount } from './ledger.js';
import { hashPassword, verifyPassword, setRevokedEpoch, MAX_PASSWORD_LEN } from './auth.js';
import { encryptPii } from './pii.js';

export class ForbiddenError extends Error {
  readonly status = 403;
  constructor(message: string) {
    super(message);
    this.name = 'ForbiddenError';
  }
}

/** A user-facing auth failure (bad input, taken email, wrong password). */
export class AuthError extends Error {
  readonly status = 400;
  constructor(message: string) {
    super(message);
    this.name = 'AuthError';
  }
}

const HANDLE_RE = /^[a-z0-9_]{3,20}$/;
const normEmail = (e: string) => e.trim().toLowerCase();

// ---------------------------------------------------------------------------
// Session revocation
// ---------------------------------------------------------------------------

/** Revoke all of a user's existing sessions (logout / password change / theft):
 *  persist the cutoff, then mirror it into the in-memory map that verifySession
 *  reads. Any token issued before this instant stops working immediately. */
export async function revokeUserSessions(userId: string, prisma: PrismaClient = defaultPrisma): Promise<void> {
  const now = new Date();
  await prisma.user.update({ where: { id: userId }, data: { sessionsValidFrom: now } });
  setRevokedEpoch(userId, now.getTime());
}

/**
 * Right-to-erasure: strip a user's personal data (email, name, avatar, bio, saved
 * shipping address, wallet) and disable the account, keeping the row so the ledger
 * and order history stay referentially intact. Sessions are revoked so the account
 * can't be used again. Shipment address snapshots for in-flight orders are left for
 * the seller to fulfil and age out under retention.
 */
export async function eraseUserData(userId: string, prisma: PrismaClient = defaultPrisma): Promise<void> {
  const anon = `deleted_${randomBytes(6).toString('hex')}`;
  const now = new Date();
  await prisma.user.update({
    where: { id: userId },
    data: {
      email: null,
      handle: anon, // unique + non-identifying
      displayName: null,
      avatarUrl: null,
      bio: null,
      shippingAddress: Prisma.DbNull,
      passwordHash: null, // can't email-login
      walletAddress: null, // can't wallet-login
      sessionsValidFrom: now, // revoke everything
    },
  });
  // Wipe the buyer's saved address snapshots on shipments that no longer need them
  // (delivered/terminal). In-flight shipments keep the address so the package can
  // still be delivered; purgeDeliveredShipmentPii clears those after delivery.
  await prisma.shipment.updateMany({
    where: { buyerId: userId, status: { in: ['DELIVERED', 'CANCELED'] } },
    data: { shipTo: Prisma.JsonNull, privateLeg2: Prisma.DbNull },
  });
  setRevokedEpoch(userId, now.getTime());
}

/** Startup: load persisted revocation cutoffs into memory so they survive restarts. */
export async function loadSessionRevocations(prisma: PrismaClient = defaultPrisma): Promise<number> {
  const users = await prisma.user.findMany({
    where: { sessionsValidFrom: { not: null } },
    select: { id: true, sessionsValidFrom: true },
  });
  for (const u of users) if (u.sessionsValidFrom) setRevokedEpoch(u.id, u.sessionsValidFrom.getTime());
  return users.length;
}

/** True if `err` is Prisma's unique-constraint violation (P2002) on `field`.
 *  The DB @unique index is the real guard against races that slip past the
 *  pre-check: this lets us turn the raw DB error into a friendly message. */
function isUniqueViolation(err: unknown, field: string): boolean {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== 'P2002') return false;
  const target = err.meta?.target;
  return Array.isArray(target) ? target.includes(field) : String(target ?? '').includes(field);
}

async function uniquePlaceholderHandle(prisma: PrismaClient): Promise<string> {
  for (let i = 0; i < 10; i++) {
    const candidate = `collector_${randomBytes(3).toString('hex')}`;
    if (!(await prisma.user.findUnique({ where: { handle: candidate } }))) return candidate;
  }
  return `collector_${randomBytes(6).toString('hex')}`;
}

/**
 * Create a real account with email + password (hashed). Persists to Postgres.
 * `handle` is optional, when omitted a placeholder is generated and the user
 * picks their real username during onboarding. New users start onboarded=false.
 */
export async function registerWithEmail(
  input: { email: string; password: string; handle?: string },
  prisma: PrismaClient = defaultPrisma,
): Promise<User> {
  const email = normEmail(input.email);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new AuthError('Enter a valid email address.');
  if (input.password.length < 8) throw new AuthError('Password must be at least 8 characters.');
  if (input.password.length > MAX_PASSWORD_LEN) throw new AuthError(`Password must be at most ${MAX_PASSWORD_LEN} characters.`);
  if (await prisma.user.findUnique({ where: { email } })) throw new AuthError('That email is already registered.');

  let handle: string;
  if (input.handle && input.handle.trim()) {
    handle = input.handle.trim().toLowerCase();
    if (!HANDLE_RE.test(handle)) throw new AuthError('Handle must be 3-20 chars: letters, numbers or underscores.');
    if (await prisma.user.findUnique({ where: { handle } })) throw new AuthError('That handle is taken.');
  } else {
    handle = await uniquePlaceholderHandle(prisma);
  }

  let user: User;
  try {
    user = await prisma.user.create({
      data: { email, handle, passwordHash: await hashPassword(input.password), role: Role.buyer },
    });
  } catch (err) {
    if (isUniqueViolation(err, 'handle')) throw new AuthError('That handle is taken.');
    if (isUniqueViolation(err, 'email')) throw new AuthError('That email is already registered.');
    throw err;
  }
  await getOrCreateUserAccount(user.id, prisma);
  return user;
}

/** Finish onboarding: set the chosen username, display name and interests. */
/**
 * Claim a username on its own, without finishing onboarding.
 *
 * Onboarding used to only validate the handle on its final submit, so someone
 * who picked a taken name learned about it several screens later. The username
 * step calls this on Continue instead: it either takes the name now or fails
 * right there. Re-affirming a name you already hold is a no-op.
 */
export async function setHandle(
  userId: string,
  rawHandle: string,
  prisma: PrismaClient = defaultPrisma,
): Promise<User> {
  const handle = rawHandle.trim().toLowerCase();
  if (!HANDLE_RE.test(handle)) throw new AuthError('Username must be 3-20 chars: letters, numbers or underscores.');
  const taken = await prisma.user.findUnique({ where: { handle }, select: { id: true } });
  if (taken && taken.id !== userId) throw new AuthError('That username is taken.');
  try {
    return await prisma.user.update({ where: { id: userId }, data: { handle } });
  } catch (err) {
    // Someone claimed it between the check and the write.
    if (isUniqueViolation(err, 'handle')) throw new AuthError('That username is taken.');
    throw err;
  }
}

export async function completeOnboarding(
  userId: string,
  input: { handle?: string; displayName?: string; interests?: string[] },
  prisma: PrismaClient = defaultPrisma,
): Promise<User> {
  const data: Record<string, unknown> = { onboarded: true };

  if (input.handle && input.handle.trim()) {
    const handle = input.handle.trim().toLowerCase();
    if (!HANDLE_RE.test(handle)) throw new AuthError('Username must be 3-20 chars: letters, numbers or underscores.');
    const taken = await prisma.user.findUnique({ where: { handle } });
    if (taken && taken.id !== userId) throw new AuthError('That username is taken.');
    data.handle = handle;
  }
  if (input.displayName !== undefined) data.displayName = input.displayName.trim() || null;
  if (Array.isArray(input.interests)) {
    data.interests = input.interests.filter((s) => typeof s === 'string').slice(0, 24);
  }

  try {
    return await prisma.user.update({ where: { id: userId }, data });
  } catch (err) {
    if (isUniqueViolation(err, 'handle')) throw new AuthError('That username is taken.');
    throw err;
  }
}

/** Verify email + password; returns the user or null (never says which field was wrong). */
export async function loginWithEmail(
  input: { email: string; password: string },
  prisma: PrismaClient = defaultPrisma,
): Promise<User | null> {
  const user = await prisma.user.findUnique({ where: { email: normEmail(input.email) } });
  if (!user || !(await verifyPassword(input.password, user.passwordHash))) return null;
  return user;
}

/** Update a user's editable profile fields. */
const SHIP_MODES = ['WEEKLY_BUNDLE', 'SHIP_LATER', 'PRIVATE'] as const;

/** Avatars are sent inline with every chat line, live card and bid feed entry,
 *  so an oversized one would bloat every one of those payloads. The client
 *  downscales to 256px (a few KB); this is the backstop for anything else.
 *  Over the cap we drop the image rather than store a payload-bloating blob. */
const MAX_AVATAR_LEN = 120_000;
function cleanAvatar(raw: string): string | null {
  const v = raw.trim();
  if (!v) return null;
  if (v.length > MAX_AVATAR_LEN) return null;
  // Inline image or a plain URL only, never a script:/javascript: payload,
  // since this string is rendered as an <img src> by every client.
  if (!/^data:image\/(png|jpeg|webp|gif);base64,/.test(v) && !/^https:\/\//.test(v)) return null;
  return v;
}

export async function updateProfile(
  userId: string,
  patch: { displayName?: string; avatarUrl?: string; bio?: string; shippingAddress?: unknown; bundleShipping?: boolean; shippingMode?: string },
  prisma: PrismaClient = defaultPrisma,
): Promise<User> {
  // A chosen shipping mode also drives the weekly-bundle opt-in (kept in sync so
  // the fulfillment path (which keys off bundleShipping) stays consistent).
  const mode = patch.shippingMode && (SHIP_MODES as readonly string[]).includes(patch.shippingMode) ? patch.shippingMode : undefined;
  return prisma.user.update({
    where: { id: userId },
    data: {
      ...(patch.displayName !== undefined ? { displayName: patch.displayName.trim() || null } : {}),
      ...(patch.avatarUrl !== undefined ? { avatarUrl: cleanAvatar(patch.avatarUrl) } : {}),
      ...(patch.bio !== undefined ? { bio: patch.bio.trim() || null } : {}),
      ...(patch.shippingAddress !== undefined
        ? { shippingAddress: encryptPii(patch.shippingAddress ?? null) as Prisma.InputJsonValue }
        : {}),
      ...(mode !== undefined ? { shippingMode: mode, bundleShipping: mode === 'WEEKLY_BUNDLE' } : {}),
      ...(patch.bundleShipping !== undefined && mode === undefined ? { bundleShipping: patch.bundleShipping } : {}),
    },
  });
}

export function getUser(userId: string, prisma: PrismaClient = defaultPrisma): Promise<User | null> {
  return prisma.user.findUnique({ where: { id: userId } });
}

function shortHandle(walletAddress: string): string {
  return walletAddress.length > 8
    ? `${walletAddress.slice(0, 4)}..${walletAddress.slice(-4)}`
    : walletAddress;
}

/** Find or create a user by their wallet address (and ensure they have an account). */
export async function findOrCreateByWallet(
  walletAddress: string,
  prisma: PrismaClient = defaultPrisma,
): Promise<User> {
  const existing = await prisma.user.findUnique({ where: { walletAddress } });
  if (existing) return existing;
  let handle = shortHandle(walletAddress);
  if (await prisma.user.findUnique({ where: { handle } })) handle = walletAddress;
  const user = await prisma.user.create({ data: { walletAddress, handle, role: Role.buyer } });
  await getOrCreateUserAccount(user.id, prisma);
  return user;
}

/** Find or create a user by handle (dev login). */
export async function findOrCreateByHandle(
  handle: string,
  prisma: PrismaClient = defaultPrisma,
): Promise<User> {
  const existing = await prisma.user.findUnique({ where: { handle } });
  const user = existing ?? (await prisma.user.create({ data: { handle, role: Role.buyer } }));
  await getOrCreateUserAccount(user.id, prisma);
  return user;
}

/** The trust badge (earned at 10 fulfilled orders or granted by an admin). */
export async function isVerifiedSeller(
  userId: string,
  prisma: PrismaClient = defaultPrisma,
): Promise<boolean> {
  const profile = await prisma.sellerProfile.findUnique({ where: { userId } });
  return profile?.verified === true;
}

/** An ACTIVE seller = has applied (has a SellerProfile). This is the gate on
 *  selling; `verified` is only the badge. */
export async function isSeller(userId: string, prisma: PrismaClient = defaultPrisma): Promise<boolean> {
  return !!(await prisma.sellerProfile.findUnique({ where: { userId }, select: { userId: true } }));
}

export async function requireSeller(userId: string, prisma: PrismaClient = defaultPrisma): Promise<void> {
  if (!(await isSeller(userId, prisma))) {
    throw new ForbiddenError('A seller account is required for this action');
  }
}

/**
 * Become a seller. Auto-approved: the SellerProfile is created immediately so
 * they can list and go live right away, but UNVERIFIED (no badge) until they
 * fulfill 10 orders or an admin verifies them. Never clobbers an admin's role,
 * and re-applying never un-verifies.
 */
export async function applyAsSeller(
  userId: string,
  prisma: PrismaClient = defaultPrisma,
): Promise<User> {
  await prisma.sellerProfile.upsert({
    where: { userId },
    update: {},
    create: { userId, verified: false, appliedAt: new Date() },
  });
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  if (user.role === Role.buyer) {
    return prisma.user.update({ where: { id: userId }, data: { role: Role.seller } });
  }
  return user;
}

/** Save the seller's onboarding / shop profile and mark onboarding complete.
 *  Deliberately does NOT touch pumpCoinAddress: coin linking must go through
 *  setSellerCoin (sellers.ts), whose first-claim-wins guard stops a seller from
 *  hijacking a coin another seller already linked. The /seller/onboarding
 *  endpoint composes the two. */
export async function submitSellerOnboarding(
  userId: string,
  input: {
    website?: string;
    socials?: Record<string, string> | null;
    pitch?: string;
    origin?: { name?: string; line1?: string; line2?: string; country?: string; region?: string; city?: string; postal?: string };
  },
  prisma: PrismaClient = defaultPrisma,
): Promise<void> {
  const o = input.origin ?? {};
  const str = (v?: string) => (v && v.trim() ? v.trim() : null);
  await prisma.sellerProfile.update({
    where: { userId },
    data: {
      onboardedSeller: true,
      ...(input.website !== undefined ? { website: str(input.website) } : {}),
      ...(input.socials !== undefined ? { socials: (input.socials ?? null) as Prisma.InputJsonValue } : {}),
      ...(input.pitch !== undefined ? { pitch: str(input.pitch) } : {}),
      ...(input.origin !== undefined
        ? {
            originName: str(o.name),
            originLine1: str(o.line1),
            originLine2: str(o.line2),
            originCountry: str(o.country),
            originRegion: str(o.region),
            originCity: str(o.city),
            originPostal: str(o.postal),
          }
        : {}),
    },
  });
}

function adminEmails(): string[] {
  return (process.env.BIDIT_ADMIN_EMAILS ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/** Admin = the `admin` role OR an email in the BIDIT_ADMIN_EMAILS allowlist (so
 *  the operator can be admin with their normal account, no DB surgery). */
export async function isAdmin(userId: string, prisma: PrismaClient = defaultPrisma): Promise<boolean> {
  const user = await getUser(userId, prisma);
  if (!user) return false;
  if (user.role === Role.admin) return true;
  const email = user.email?.toLowerCase();
  return !!email && adminEmails().includes(email);
}

export async function requireAdmin(
  userId: string,
  prisma: PrismaClient = defaultPrisma,
): Promise<void> {
  if (!(await isAdmin(userId, prisma))) {
    throw new ForbiddenError('Admin access required');
  }
}
