/**
 * HTTP transport policy helpers — pure and env-injectable so they're unit-tested
 * without standing up the server.
 */

/** Production = explicit flag or a real-money mainnet chain. */
export function corsIsProd(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.BIDIT_ENV === 'production' || env.SOLANA_CLUSTER === 'mainnet-beta';
}

/** Origins allowed to call the API in production (comma-separated env). */
export function corsAllowlist(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = env.BIDIT_ALLOWED_ORIGINS;
  return raw && raw.trim() ? raw.split(',').map((s) => s.trim()).filter(Boolean) : [];
}

/**
 * The value to echo in Access-Control-Allow-Origin for a request's Origin:
 *  - dev/preview: reflect the caller (convenient, and no cookies are used).
 *  - production: only origins on the explicit allowlist; everything else gets ''.
 */
export function corsAllowOrigin(origin: string, env: NodeJS.ProcessEnv = process.env): string {
  if (!origin) return '';
  if (!corsIsProd(env)) return origin;
  return corsAllowlist(env).includes(origin) ? origin : '';
}
