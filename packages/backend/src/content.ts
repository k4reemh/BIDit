/**
 * Editable site copy — a key→value store the web reads at runtime (falling back
 * to in-code defaults). Lets marketing/help/footer text change with no code
 * change or redeploy. Writes are gated by the admin key in the dev-server route.
 */
import { prisma as defaultPrisma } from './db.js';
import type { PrismaClient } from './db.js';

const MAX_VALUE_LEN = 5000;

/** All overrides as a plain map. Public — this is just display copy. */
export async function getAllContent(prisma: PrismaClient = defaultPrisma): Promise<Record<string, string>> {
  const rows = await prisma.siteContent.findMany();
  const out: Record<string, string> = {};
  for (const r of rows) out[r.key] = r.value;
  return out;
}

/** Upsert a batch of key→value copy overrides. Returns how many were written.
 *  Empty-string values are stored (a deliberate "blank this out"). */
export async function setContent(
  entries: Record<string, unknown>,
  prisma: PrismaClient = defaultPrisma,
): Promise<number> {
  let n = 0;
  for (const [key, raw] of Object.entries(entries)) {
    if (typeof key !== 'string' || !key || key.length > 200) continue;
    const value = String(raw ?? '').slice(0, MAX_VALUE_LEN);
    await prisma.siteContent.upsert({ where: { key }, update: { value }, create: { key, value } });
    n += 1;
  }
  return n;
}
