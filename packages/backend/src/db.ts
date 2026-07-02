import { PrismaClient } from '@prisma/client';

/**
 * Single shared Prisma client. Reads DATABASE_URL from the environment, which
 * the embedded-postgres harness (scripts/with-db.ts) injects for local/test
 * runs and which points at managed Postgres in a real deployment.
 */
export const prisma = new PrismaClient();

export type { PrismaClient } from '@prisma/client';
