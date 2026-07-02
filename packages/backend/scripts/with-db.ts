/**
 * Wrapper that:
 *   1. starts embedded Postgres,
 *   2. pushes the Prisma schema into it,
 *   3. runs the given command with DATABASE_URL injected,
 *   4. tears the DB down and forwards the command's exit code.
 *
 * Usage: tsx scripts/with-db.ts <command> [...args]
 *   e.g. tsx scripts/with-db.ts vitest run
 *        tsx scripts/with-db.ts tsx scripts/demo.ts
 */
import { spawn } from 'node:child_process';
import { startDb, stopDb, DATABASE_URL } from './db.js';

function run(command: string, args: string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: 'inherit',
      env: { ...process.env, DATABASE_URL },
    });
    child.on('error', reject);
    child.on('exit', (code) => resolve(code ?? 1));
  });
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (!command) {
    console.error('Usage: with-db <command> [...args]');
    process.exit(2);
  }

  let exitCode = 1;
  await startDb();
  try {
    const pushCode = await run('prisma', [
      'db',
      'push',
      '--skip-generate',
      '--accept-data-loss',
    ]);
    if (pushCode !== 0) {
      throw new Error(`prisma db push failed (exit ${pushCode})`);
    }
    exitCode = await run(command, args);
  } catch (err) {
    console.error('[with-db]', err);
    exitCode = 1;
  } finally {
    await stopDb();
  }
  process.exit(exitCode);
}

// If we're terminated (e.g. SIGTERM at a turn boundary), still stop Postgres so
// we never leave an orphan holding the data-dir lock and hanging the next run.
let cleaningUp = false;
async function cleanupAndExit(code: number): Promise<void> {
  if (cleaningUp) return;
  cleaningUp = true;
  await stopDb().catch(() => {});
  process.exit(code);
}
process.on('SIGINT', () => void cleanupAndExit(130));
process.on('SIGTERM', () => void cleanupAndExit(143));

main().catch((err) => {
  console.error('[with-db] failed to start:', err);
  void stopDb().finally(() => process.exit(1));
});
