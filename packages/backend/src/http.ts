/**
 * HTTP transport policy helpers — pure and env-injectable so they're unit-tested
 * without standing up the server.
 */

/** Production = explicit flag or a real-money mainnet chain. */
export function corsIsProd(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.BIDIT_ENV === 'production' || env.SOLANA_CLUSTER === 'mainnet-beta';
}

/** Canonical form for comparing origins: no trailing slash, lower-cased. Browsers
 *  send an Origin with no path, but humans paste allowlist values with a trailing
 *  slash or odd casing — normalising both sides avoids a silent total outage. */
function normalizeOrigin(o: string): string {
  return o.trim().replace(/\/+$/, '').toLowerCase();
}

/** Origins allowed to call the API in production (comma-separated env), normalised. */
export function corsAllowlist(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = env.BIDIT_ALLOWED_ORIGINS;
  return raw && raw.trim() ? raw.split(',').map(normalizeOrigin).filter(Boolean) : [];
}

/**
 * The value to echo in Access-Control-Allow-Origin for a request's Origin:
 *  - dev/preview: reflect the caller (convenient, and no cookies are used).
 *  - production WITH an allowlist: only origins on it (trailing-slash/case tolerant).
 *  - production WITHOUT an allowlist: reflect the caller (fail-open) so a missing or
 *    blank BIDIT_ALLOWED_ORIGINS can never take the whole site offline. Safe because
 *    sessions are bearer tokens (not cookies), so permissive CORS ≠ credential theft.
 * Always echoes the caller's exact Origin string (browsers require an exact match).
 */
export function corsAllowOrigin(origin: string, env: NodeJS.ProcessEnv = process.env): string {
  if (!origin) return '';
  if (!corsIsProd(env)) return origin;
  const allow = corsAllowlist(env);
  if (allow.length === 0) return origin; // fail-open: unconfigured allowlist ≠ outage
  return allow.includes(normalizeOrigin(origin)) ? origin : '';
}
