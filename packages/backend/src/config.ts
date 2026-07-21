/**
 * Startup configuration guard.
 *
 * A production / real-money boot MUST fail fast rather than run degraded. The two
 * dangerous silent-failure modes this closes:
 *   1. AUTH_SECRET missing → sessions are signed with a public default string, so
 *      anyone can forge a token for any user (including admin).
 *   2. SOLANA_RPC missing → getChainClient() silently returns MockChain, so a
 *      "production" deploy boots with fake money AND dev endpoints enabled.
 *
 * assertStartupConfig() is pure (env in, throw out) so it is unit-tested, and is
 * called once from the server entrypoint before it accepts any traffic.
 */

export const AUTH_SECRET_FALLBACK = 'dev-insecure-secret-change-me';
const MIN_AUTH_SECRET_LEN = 32;
const MIN_WALLET_SEED_LEN = 24;
/** Must match MIN_KEY_LEN in pii.ts — below this, encryptPii stores plaintext. */
const MIN_PII_KEY_LEN = 16;

export class StartupConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StartupConfigError';
  }
}

export interface StartupCheck {
  /** True when this boot is held to real-money standards (explicit prod or mainnet). */
  isProd: boolean;
  cluster: string;
}

/**
 * Validate the environment for the chain we're about to run on. Throws
 * StartupConfigError (which the entrypoint turns into a non-zero exit) on any
 * unsafe production configuration. Returns { isProd } so the caller can force
 * dev conveniences off.
 */
export function assertStartupConfig(cluster: string, env: NodeJS.ProcessEnv = process.env): StartupCheck {
  // Real money (mainnet) always demands prod hardening; an explicit flag lets a
  // devnet/staging deploy opt into the same strictness.
  const isProd = env.BIDIT_ENV === 'production' || cluster === 'mainnet-beta';
  // Any non-mock chain is network-exposed and signs real sessions — even a devnet
  // box that forgot BIDIT_ENV=production must not run on the public default secret.
  const realChain = cluster !== 'mock';
  const problems: string[] = [];

  // 1. Session secret must be a real, strong value on ANY real deploy (not just
  //    prod) — the shipped default lets anyone forge a token for any user/admin.
  if (isProd || realChain) {
    const secret = env.AUTH_SECRET;
    if (!secret || secret === AUTH_SECRET_FALLBACK) {
      problems.push('AUTH_SECRET is missing or the insecure default — set a strong random value (≥32 chars).');
    } else if (secret.length < MIN_AUTH_SECRET_LEN) {
      problems.push(`AUTH_SECRET is too short (${secret.length} chars) — use ≥${MIN_AUTH_SECRET_LEN} random chars.`);
    }
  }

  if (isProd) {
    // 2. Never a mock chain in production (fake deposits/withdrawals look real).
    if (cluster === 'mock') {
      problems.push('Chain is MockChain on a production boot — set SOLANA_RPC (+ SOLANA_CLUSTER) to a real chain.');
    }

    // 3. Dev endpoints (password-less login, balance minting, seeders) must never
    //    be force-enabled in production.
    if (env.BIDIT_ENABLE_DEV_ENDPOINTS === 'yes') {
      problems.push('BIDIT_ENABLE_DEV_ENDPOINTS=yes is set in production — it exposes balance-minting and auth-bypass routes; remove it.');
    }

    // 4. Real-money custody secrets (mainnet). SolanaChain.fromEnv() also checks
    //    these when the real chain is built; asserting here gives one clear, early
    //    failure listing everything at once.
    if (cluster === 'mainnet-beta') {
      if (!env.TREASURY_SECRET) {
        problems.push('TREASURY_SECRET is missing — the treasury hot wallet that pays out funds.');
      }
      const seed = env.BIDIT_WALLET_SEED;
      if (!seed || seed.length < MIN_WALLET_SEED_LEN) {
        problems.push(`BIDIT_WALLET_SEED is missing or weak (≥${MIN_WALLET_SEED_LEN} chars) — it derives every user deposit address.`);
      }
    }

    // 5. PII key must be present — without it encryptPii() silently stores every
    //    shipping address as plaintext (a data-protection failure, not just a warn).
    const piiKey = env.BIDIT_PII_KEY;
    if (!piiKey || piiKey.trim().length < MIN_PII_KEY_LEN) {
      problems.push(`BIDIT_PII_KEY is missing or too short (≥${MIN_PII_KEY_LEN} chars) — shipping addresses would be stored as plaintext.`);
    }
  }

  if (problems.length > 0) {
    throw new StartupConfigError(
      'Refusing to start — unsafe production configuration:\n' + problems.map((p) => `  • ${p}`).join('\n'),
    );
  }

  return { isProd, cluster };
}

/** True if AUTH_SECRET is unset or still the insecure shipped default. */
export function usingDefaultAuthSecret(env: NodeJS.ProcessEnv = process.env): boolean {
  return !env.AUTH_SECRET || env.AUTH_SECRET === AUTH_SECRET_FALLBACK;
}
