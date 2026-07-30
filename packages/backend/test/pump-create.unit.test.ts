import { describe, it, expect, afterEach } from 'vitest';
import {
  pumpCoinName,
  pumpCoinSymbol,
  pumpCoinDescription,
  webOrigin,
} from '../src/pump-create.js';
import {
  getPumpCreateProvider,
  MockPumpCreateProvider,
  MockOffchainProvider,
  PumpOffchainProvider,
  PumpPortalProvider,
} from '../src/chain/pump-provider.js';

const ENV_KEYS = ['BIDIT_PUMP_PROVIDER', 'BIDIT_WEB_ORIGIN'] as const;
const saved: Record<string, string | undefined> = {};
for (const k of ENV_KEYS) saved[k] = process.env[k];
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('pumpCoinName', () => {
  it('keeps a short handle intact', () => {
    expect(pumpCoinName('jane')).toBe("jane's BIDit Livestream");
  });

  it('clips a long handle so the whole name fits 32 bytes, keeping the full suffix', () => {
    const name = pumpCoinName('a'.repeat(20));
    expect(name.endsWith("'s BIDit Livestream")).toBe(true);
    expect(Buffer.byteLength(name, 'utf8')).toBeLessThanOrEqual(32);
    expect(name.startsWith('a'.repeat(13))).toBe(true);
  });

  it('never splits a multi-byte character when clipping', () => {
    const name = pumpCoinName('日本語のハンドル長すぎる'); // 3 bytes per char
    expect(Buffer.byteLength(name, 'utf8')).toBeLessThanOrEqual(32);
    expect(name.endsWith("'s BIDit Livestream")).toBe(true);
    // Whatever survived must still be valid UTF-8 round-trippable text.
    expect(Buffer.from(name, 'utf8').toString('utf8')).toBe(name);
  });
});

describe('pumpCoinSymbol', () => {
  it('uppercases and caps at 10 chars', () => {
    expect(pumpCoinSymbol('krispyk4reem')).toBe('KRISPYK4RE');
  });

  it('strips non-alphanumerics', () => {
    expect(pumpCoinSymbol('a_b-c.d')).toBe('ABCD');
  });

  it('falls back to BIDIT for degenerate handles', () => {
    expect(pumpCoinSymbol('___')).toBe('BIDIT');
  });
});

describe('pumpCoinDescription', () => {
  it('links the coin to its own watch page on the configured origin', () => {
    process.env.BIDIT_WEB_ORIGIN = 'https://bidit.example';
    const d = pumpCoinDescription('jane', 'MINT123');
    expect(d).toContain('https://bidit.example/live/MINT123');
    expect(d).toContain('jane');
  });

  it('strips a trailing slash from the env origin', () => {
    process.env.BIDIT_WEB_ORIGIN = 'https://bidit.example/';
    expect(webOrigin()).toBe('https://bidit.example');
  });
});

describe('getPumpCreateProvider', () => {
  it('mocks everywhere except mainnet, and never picks the on-chain path by itself', () => {
    delete process.env.BIDIT_PUMP_PROVIDER;
    expect(getPumpCreateProvider('mock')).toBeInstanceOf(MockOffchainProvider);
    expect(getPumpCreateProvider('devnet')).toBeInstanceOf(MockOffchainProvider);
    // Mainnet sellers get the free, warning-free path, never PumpPortal, which
    // costs network fees and makes the wallet flash a scary-tx warning.
    expect(getPumpCreateProvider('mainnet-beta')).toBeInstanceOf(PumpOffchainProvider);
  });

  it('honors the BIDIT_PUMP_PROVIDER override in every direction', () => {
    process.env.BIDIT_PUMP_PROVIDER = 'mock';
    expect(getPumpCreateProvider('mainnet-beta')).toBeInstanceOf(MockPumpCreateProvider);
    process.env.BIDIT_PUMP_PROVIDER = 'pumpportal';
    expect(getPumpCreateProvider('mock')).toBeInstanceOf(PumpPortalProvider);
    process.env.BIDIT_PUMP_PROVIDER = 'offchain';
    expect(getPumpCreateProvider('mock')).toBeInstanceOf(PumpOffchainProvider);
  });
});

describe('MockPumpCreateProvider', () => {
  it('mints look like real base58 mint addresses', async () => {
    const p = new MockPumpCreateProvider();
    const prepared = await p.prepareCreate({
      creatorWallet: null,
      name: "jane's BIDit Livestream",
      symbol: 'JANE',
      describe: (m) => `coin ${m}`,
      imagePng: null,
    });
    expect(prepared.mint).toMatch(/^[A-Za-z0-9]{32,50}$/);
    expect(prepared.signMode).toBe('none');
  });
});
