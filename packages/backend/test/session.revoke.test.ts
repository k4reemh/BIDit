import { describe, it, expect, beforeEach } from 'vitest';
import { prisma } from '../src/db.js';
import { issueSession, verifySession } from '../src/auth.js';
import { revokeUserSessions, loadSessionRevocations } from '../src/authz.js';
import { resetDb, makeUser } from './setup.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeEach(async () => {
  await resetDb();
});

describe('session revocation (durable)', () => {
  it('revokeUserSessions kills existing tokens and persists the cutoff', async () => {
    const u = await makeUser();
    const tok = issueSession(u.userId);
    expect(verifySession(tok)).toBe(u.userId);

    await sleep(3);
    await revokeUserSessions(u.userId, prisma);

    expect(verifySession(tok)).toBeNull(); // revoked in-memory immediately
    const row = await prisma.user.findUniqueOrThrow({ where: { id: u.userId } });
    expect(row.sessionsValidFrom).not.toBeNull(); // persisted for restart survival
  });

  it('loadSessionRevocations re-applies a cutoff persisted by a previous process', async () => {
    const u = await makeUser();
    const tok = issueSession(u.userId); // iat = t0

    await sleep(5);
    // Simulate a revocation from an earlier run: persisted to the DB only, not in
    // this process's in-memory map yet.
    await prisma.user.update({ where: { id: u.userId }, data: { sessionsValidFrom: new Date() } });
    expect(verifySession(tok)).toBe(u.userId); // stale — not hydrated, still passes

    const n = await loadSessionRevocations(prisma);
    expect(n).toBeGreaterThanOrEqual(1);
    expect(verifySession(tok)).toBeNull(); // now enforced after startup hydration
  });
});
