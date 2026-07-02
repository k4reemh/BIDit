/** User resolution + authorization gates. */
import { randomBytes } from 'node:crypto';
import { Role } from '@bidit/shared';
import { Prisma, type User } from '@prisma/client';
import { prisma as defaultPrisma } from './db.js';
import type { PrismaClient } from './db.js';
import { getOrCreateUserAccount } from './ledger.js';
import { hashPassword, verifyPassword } from './auth.js';

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

async function uniquePlaceholderHandle(prisma: PrismaClient): Promise<string> {
  for (let i = 0; i < 10; i++) {
    const candidate = `collector_${randomBytes(3).toString('hex')}`;
    if (!(await prisma.user.findUnique({ where: { handle: candidate } }))) return candidate;
  }
  return `collector_${randomBytes(6).toString('hex')}`;
}

/**
 * Create a real account with email + password (hashed). Persists to Postgres.
 * `handle` is optional — when omitted a placeholder is generated and the user
 * picks their real username during onboarding. New users start onboarded=false.
 */
export async function registerWithEmail(
  input: { email: string; password: string; handle?: string },
  prisma: PrismaClient = defaultPrisma,
): Promise<User> {
  const email = normEmail(input.email);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new AuthError('Enter a valid email address.');
  if (input.password.length < 8) throw new AuthError('Password must be at least 8 characters.');
  if (await prisma.user.findUnique({ where: { email } })) throw new AuthError('That email is already registered.');

  let handle: string;
  if (input.handle && input.handle.trim()) {
    handle = input.handle.trim().toLowerCase();
    if (!HANDLE_RE.test(handle)) throw new AuthError('Handle must be 3–20 chars: letters, numbers or underscores.');
    if (await prisma.user.findUnique({ where: { handle } })) throw new AuthError('That handle is taken.');
  } else {
    handle = await uniquePlaceholderHandle(prisma);
  }

  const user = await prisma.user.create({
    data: { email, handle, passwordHash: hashPassword(input.password), role: Role.buyer },
  });
  await getOrCreateUserAccount(user.id, prisma);
  return user;
}

/** Finish onboarding: set the chosen username, display name and interests. */
export async function completeOnboarding(
  userId: string,
  input: { handle?: string; displayName?: string; interests?: string[] },
  prisma: PrismaClient = defaultPrisma,
): Promise<User> {
  const data: Record<string, unknown> = { onboarded: true };

  if (input.handle && input.handle.trim()) {
    const handle = input.handle.trim().toLowerCase();
    if (!HANDLE_RE.test(handle)) throw new AuthError('Username must be 3–20 chars: letters, numbers or underscores.');
    const taken = await prisma.user.findUnique({ where: { handle } });
    if (taken && taken.id !== userId) throw new AuthError('That username is taken.');
    data.handle = handle;
  }
  if (input.displayName !== undefined) data.displayName = input.displayName.trim() || null;
  if (Array.isArray(input.interests)) {
    data.interests = input.interests.filter((s) => typeof s === 'string').slice(0, 24);
  }

  return prisma.user.update({ where: { id: userId }, data });
}

/** Verify email + password; returns the user or null (never says which field was wrong). */
export async function loginWithEmail(
  input: { email: string; password: string },
  prisma: PrismaClient = defaultPrisma,
): Promise<User | null> {
  const user = await prisma.user.findUnique({ where: { email: normEmail(input.email) } });
  if (!user || !verifyPassword(input.password, user.passwordHash)) return null;
  return user;
}

/** Update a user's editable profile fields. */
export async function updateProfile(
  userId: string,
  patch: { displayName?: string; avatarUrl?: string; bio?: string; shippingAddress?: unknown },
  prisma: PrismaClient = defaultPrisma,
): Promise<User> {
  return prisma.user.update({
    where: { id: userId },
    data: {
      ...(patch.displayName !== undefined ? { displayName: patch.displayName.trim() || null } : {}),
      ...(patch.avatarUrl !== undefined ? { avatarUrl: patch.avatarUrl.trim() || null } : {}),
      ...(patch.bio !== undefined ? { bio: patch.bio.trim() || null } : {}),
      ...(patch.shippingAddress !== undefined
        ? { shippingAddress: (patch.shippingAddress ?? null) as Prisma.InputJsonValue }
        : {}),
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

export async function isVerifiedSeller(
  userId: string,
  prisma: PrismaClient = defaultPrisma,
): Promise<boolean> {
  const profile = await prisma.sellerProfile.findUnique({ where: { userId } });
  return profile?.verified === true;
}

export async function requireVerifiedSeller(
  userId: string,
  prisma: PrismaClient = defaultPrisma,
): Promise<void> {
  if (!(await isVerifiedSeller(userId, prisma))) {
    throw new ForbiddenError('A verified seller account is required for this action');
  }
}

/**
 * Turn a user into a seller. In production this is gated behind KYC + admin
 * review; for the dev/beta build it auto-verifies so the seller dashboard is
 * usable end-to-end.
 */
export async function applyAsSeller(
  userId: string,
  prisma: PrismaClient = defaultPrisma,
): Promise<User> {
  await prisma.sellerProfile.upsert({
    where: { userId },
    update: { verified: true },
    create: { userId, verified: true },
  });
  return prisma.user.update({ where: { id: userId }, data: { role: Role.seller } });
}

export async function requireAdmin(
  userId: string,
  prisma: PrismaClient = defaultPrisma,
): Promise<void> {
  const user = await getUser(userId, prisma);
  if (user?.role !== Role.admin) {
    throw new ForbiddenError('Admin access required');
  }
}
