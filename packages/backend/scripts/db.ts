/**
 * Local PostgreSQL via embedded-postgres — a real Postgres server, no Docker and
 * no system install. Gives us genuine row-lock / concurrent-transaction
 * semantics so the double-spend tests actually mean something.
 */
import EmbeddedPostgres from 'embedded-postgres';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

// Separate clusters for dev vs test so `npm run dev` and `npm test` never fight
// over the same data dir/port, and test fixtures never leak into the dev DB.
const PROFILE = process.env.BIDIT_PG_PROFILE === 'test' ? 'test' : 'dev';

export const DATA_DIR = path.resolve(here, PROFILE === 'test' ? '../.pgdata-test' : '../.pgdata');
export const PG_PORT = PROFILE === 'test' ? 54330 : 54329;
const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const PG_DB = PROFILE === 'test' ? 'bidit_test' : 'bidit';

export const DATABASE_URL = `postgresql://${PG_USER}:${PG_PASSWORD}@127.0.0.1:${PG_PORT}/${PG_DB}?connection_limit=20`;

let instance: EmbeddedPostgres | null = null;

export async function startDb(): Promise<void> {
  if (instance) return;
  const pg = new EmbeddedPostgres({
    databaseDir: DATA_DIR,
    user: PG_USER,
    password: PG_PASSWORD,
    port: PG_PORT,
    persistent: true,
    // NOTE: do not raise log_min_messages above LOG here. embedded-postgres
    // detects readiness by watching stderr for the LOG-level line "database
    // system is ready to accept connections"; suppressing it hangs start()
    // forever. The handled unique-constraint ERROR lines from the idempotency
    // test are cosmetic and filtered when we present results instead.
  });

  const initialised = existsSync(path.join(DATA_DIR, 'PG_VERSION'));
  if (!initialised) {
    console.log('[db] initialising embedded postgres data dir...');
    await pg.initialise();
  }
  console.log(`[db] starting embedded postgres on port ${PG_PORT}...`);
  await pg.start();
  try {
    await pg.createDatabase(PG_DB);
  } catch {
    // Database already exists — fine for a persistent data dir.
  }
  instance = pg;
  console.log('[db] ready:', DATABASE_URL);
}

export async function stopDb(): Promise<void> {
  if (!instance) return;
  console.log('[db] stopping embedded postgres...');
  await instance.stop();
  instance = null;
}
