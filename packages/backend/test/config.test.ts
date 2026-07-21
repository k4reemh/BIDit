import { describe, it, expect } from 'vitest';
import { assertStartupConfig, usingDefaultAuthSecret, StartupConfigError, AUTH_SECRET_FALLBACK } from '../src/config.js';

const STRONG = 'x'.repeat(48); // a stand-in strong secret (≥32 chars)
const SEED = 's'.repeat(32);
const PII = 'p'.repeat(24); // a stand-in PII key (≥16 chars)

describe('assertStartupConfig', () => {
  it('allows a local mock boot with no secrets', () => {
    const r = assertStartupConfig('mock', {});
    expect(r.isProd).toBe(false);
  });

  it('requires a strong AUTH_SECRET on ANY real chain — even devnet with no prod flag (H2)', () => {
    // A network-exposed devnet/staging box that forgot BIDIT_ENV=production must
    // not boot on the shipped default — anyone could forge admin tokens.
    expect(() => assertStartupConfig('devnet', {})).toThrow(/AUTH_SECRET is missing/);
    expect(() => assertStartupConfig('devnet', { AUTH_SECRET: AUTH_SECRET_FALLBACK })).toThrow(/insecure default/);
    // A strong secret is enough for a plain (non-prod) devnet boot — no PII/custody yet.
    expect(() => assertStartupConfig('devnet', { AUTH_SECRET: STRONG })).not.toThrow();
  });

  it('hard-fails a production boot with no BIDIT_PII_KEY (H3)', () => {
    expect(() => assertStartupConfig('devnet', { BIDIT_ENV: 'production', AUTH_SECRET: STRONG }))
      .toThrow(/BIDIT_PII_KEY/);
    expect(() => assertStartupConfig('mainnet-beta', { AUTH_SECRET: STRONG, TREASURY_SECRET: 'k', BIDIT_WALLET_SEED: SEED, BIDIT_PII_KEY: 'short' }))
      .toThrow(/BIDIT_PII_KEY/);
  });

  it('treats mainnet as production and requires a strong AUTH_SECRET', () => {
    expect(() => assertStartupConfig('mainnet-beta', { TREASURY_SECRET: 'k', BIDIT_WALLET_SEED: SEED }))
      .toThrow(/AUTH_SECRET is missing/);
  });

  it('rejects the shipped default secret in production', () => {
    expect(() => assertStartupConfig('devnet', { BIDIT_ENV: 'production', AUTH_SECRET: AUTH_SECRET_FALLBACK }))
      .toThrow(/insecure default/);
  });

  it('rejects a too-short AUTH_SECRET in production', () => {
    expect(() => assertStartupConfig('devnet', { BIDIT_ENV: 'production', AUTH_SECRET: 'short' }))
      .toThrow(/too short/);
  });

  it('refuses a mock chain when BIDIT_ENV=production', () => {
    expect(() => assertStartupConfig('mock', { BIDIT_ENV: 'production', AUTH_SECRET: STRONG }))
      .toThrow(/MockChain on a production boot/);
  });

  it('refuses force-enabled dev endpoints in production', () => {
    expect(() => assertStartupConfig('devnet', { BIDIT_ENV: 'production', AUTH_SECRET: STRONG, BIDIT_ENABLE_DEV_ENDPOINTS: 'yes' }))
      .toThrow(/BIDIT_ENABLE_DEV_ENDPOINTS/);
  });

  it('requires custody secrets on mainnet', () => {
    let err: unknown;
    try { assertStartupConfig('mainnet-beta', { AUTH_SECRET: STRONG }); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(StartupConfigError);
    expect((err as Error).message).toMatch(/TREASURY_SECRET is missing/);
    expect((err as Error).message).toMatch(/BIDIT_WALLET_SEED is missing or weak/);
  });

  it('rejects a weak wallet seed on mainnet', () => {
    expect(() => assertStartupConfig('mainnet-beta', { AUTH_SECRET: STRONG, TREASURY_SECRET: 'k', BIDIT_WALLET_SEED: 'short' }))
      .toThrow(/BIDIT_WALLET_SEED is missing or weak/);
  });

  it('passes a fully-configured mainnet boot', () => {
    const r = assertStartupConfig('mainnet-beta', { AUTH_SECRET: STRONG, TREASURY_SECRET: 'k', BIDIT_WALLET_SEED: SEED, BIDIT_PII_KEY: PII });
    expect(r.isProd).toBe(true);
  });

  it('passes an explicit-production devnet boot with a strong secret + PII key', () => {
    const r = assertStartupConfig('devnet', { BIDIT_ENV: 'production', AUTH_SECRET: STRONG, BIDIT_PII_KEY: PII });
    expect(r.isProd).toBe(true);
  });

  it('collects every problem into one error, not just the first', () => {
    let msg = '';
    try { assertStartupConfig('mock', { BIDIT_ENV: 'production' }); } catch (e) { msg = (e as Error).message; }
    expect(msg).toMatch(/AUTH_SECRET/);
    expect(msg).toMatch(/MockChain/);
  });
});

describe('usingDefaultAuthSecret', () => {
  it('flags a missing or default secret and clears on a real one', () => {
    expect(usingDefaultAuthSecret({})).toBe(true);
    expect(usingDefaultAuthSecret({ AUTH_SECRET: AUTH_SECRET_FALLBACK })).toBe(true);
    expect(usingDefaultAuthSecret({ AUTH_SECRET: STRONG })).toBe(false);
  });
});
