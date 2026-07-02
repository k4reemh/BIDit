import { SYSTEM_ACCOUNT_IDS, AccountKind } from '@bidit/shared';
import type { PrismaClient } from './db.js';

/**
 * Ensure the two singleton system accounts exist. Idempotent — safe to call on
 * every boot and in test setup.
 */
export async function ensureSystemAccounts(prisma: PrismaClient): Promise<void> {
  await prisma.account.upsert({
    where: { id: SYSTEM_ACCOUNT_IDS.EXTERNAL },
    update: {},
    create: { id: SYSTEM_ACCOUNT_IDS.EXTERNAL, kind: AccountKind.EXTERNAL },
  });
  await prisma.account.upsert({
    where: { id: SYSTEM_ACCOUNT_IDS.PLATFORM },
    update: {},
    create: { id: SYSTEM_ACCOUNT_IDS.PLATFORM, kind: AccountKind.PLATFORM },
  });
  await prisma.account.upsert({
    where: { id: SYSTEM_ACCOUNT_IDS.ESCROW },
    update: {},
    create: { id: SYSTEM_ACCOUNT_IDS.ESCROW, kind: AccountKind.ESCROW },
  });
}
