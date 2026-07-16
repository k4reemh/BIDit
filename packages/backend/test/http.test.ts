import { describe, it, expect } from 'vitest';
import { corsAllowOrigin, corsIsProd } from '../src/http.js';

const ORIGIN = 'https://bidit.app';
const OTHER = 'https://evil.example';

describe('CORS origin policy', () => {
  it('reflects any origin in dev (no prod flag, no mainnet)', () => {
    expect(corsAllowOrigin(ORIGIN, {})).toBe(ORIGIN);
    expect(corsAllowOrigin(OTHER, {})).toBe(OTHER);
  });

  it('returns empty for a missing origin', () => {
    expect(corsAllowOrigin('', {})).toBe('');
    expect(corsAllowOrigin('', { BIDIT_ENV: 'production', BIDIT_ALLOWED_ORIGINS: ORIGIN })).toBe('');
  });

  it('in production, echoes only allow-listed origins', () => {
    const env = { BIDIT_ENV: 'production', BIDIT_ALLOWED_ORIGINS: `${ORIGIN}, https://www.bidit.app` };
    expect(corsAllowOrigin(ORIGIN, env)).toBe(ORIGIN);
    expect(corsAllowOrigin('https://www.bidit.app', env)).toBe('https://www.bidit.app');
    expect(corsAllowOrigin(OTHER, env)).toBe(''); // not on the list → blocked
  });

  it('in production with no allowlist configured, fails open (reflects) rather than blocking the whole site', () => {
    expect(corsAllowOrigin(ORIGIN, { BIDIT_ENV: 'production' })).toBe(ORIGIN);
    expect(corsAllowOrigin(OTHER, { BIDIT_ENV: 'production', BIDIT_ALLOWED_ORIGINS: '  ' })).toBe(OTHER);
  });

  it('tolerates trailing slashes and casing in the configured allowlist', () => {
    const env = { BIDIT_ENV: 'production', BIDIT_ALLOWED_ORIGINS: 'https://BIDit.app/ , https://www.bidit.app/' };
    expect(corsAllowOrigin('https://bidit.app', env)).toBe('https://bidit.app'); // echoes exact caller origin
    expect(corsAllowOrigin('https://www.bidit.app', env)).toBe('https://www.bidit.app');
    expect(corsAllowOrigin(OTHER, env)).toBe('');
  });

  it('mainnet cluster counts as production even without the flag', () => {
    const env = { SOLANA_CLUSTER: 'mainnet-beta', BIDIT_ALLOWED_ORIGINS: ORIGIN };
    expect(corsIsProd(env)).toBe(true);
    expect(corsAllowOrigin(ORIGIN, env)).toBe(ORIGIN);
    expect(corsAllowOrigin(OTHER, env)).toBe('');
  });
});
