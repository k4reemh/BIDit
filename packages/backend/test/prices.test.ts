import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  getSolUsdPrice, lamportsToUsdcMicros, usdToMicro, solSpreadBps, clearPriceCache,
} from '../src/prices.js';

const NOW = 1_800_000_000_000; // fixed clock
const nowS = Math.floor(NOW / 1000);

type Route = { pyth?: unknown | Error; coinbase?: unknown | Error };

/** Fetcher stub: routes by URL substring, counts calls. */
function fetcher(routes: Route) {
  const calls: string[] = [];
  const f = (async (url: string | URL) => {
    const u = String(url);
    calls.push(u);
    const body = u.includes('pyth') ? routes.pyth : routes.coinbase;
    if (body instanceof Error) throw body;
    return { ok: true, status: 200, json: async () => body } as Response;
  }) as typeof fetch;
  return { f, calls };
}

const pythBody = (priceMicroish = '7652000000', publish = nowS) => ({
  parsed: [{ price: { price: priceMicroish, expo: -8, publish_time: publish } }],
});
const cbBody = (amount = '76.52') => ({ data: { amount } });

const ORIGINAL_SPREAD = process.env.BIDIT_SOL_SPREAD_BPS;
beforeEach(() => clearPriceCache());
afterEach(() => {
  if (ORIGINAL_SPREAD === undefined) delete process.env.BIDIT_SOL_SPREAD_BPS;
  else process.env.BIDIT_SOL_SPREAD_BPS = ORIGINAL_SPREAD;
});

describe('sol price oracle', () => {
  it('agrees both sources and prefers pyth', async () => {
    const { f } = fetcher({ pyth: pythBody(), coinbase: cbBody('76.60') });
    const p = await getSolUsdPrice(f, () => NOW);
    expect(p.usdMicro).toBe(76_520_000n);
    expect(p.source).toBe('pyth+coinbase');
  });

  it('refuses a divergent pair (>2%)', async () => {
    const { f } = fetcher({ pyth: pythBody('7652000000'), coinbase: cbBody('80.00') });
    await expect(getSolUsdPrice(f, () => NOW)).rejects.toThrow(/divergent/);
  });

  it('falls back to coinbase when pyth is stale', async () => {
    const { f } = fetcher({ pyth: pythBody('7652000000', nowS - 600), coinbase: cbBody('76.10') });
    const p = await getSolUsdPrice(f, () => NOW);
    expect(p.source).toBe('coinbase');
    expect(p.usdMicro).toBe(76_100_000n);
  });

  it('falls back to pyth alone when coinbase errors', async () => {
    const { f } = fetcher({ pyth: pythBody(), coinbase: new Error('down') });
    const p = await getSolUsdPrice(f, () => NOW);
    expect(p.source).toBe('pyth');
  });

  it('throws when both sources fail (no crediting without a price)', async () => {
    const { f } = fetcher({ pyth: new Error('down'), coinbase: new Error('down') });
    await expect(getSolUsdPrice(f, () => NOW)).rejects.toThrow(/no sol price/);
  });

  it('caches for the TTL (one fetch pair for two calls)', async () => {
    const { f, calls } = fetcher({ pyth: pythBody(), coinbase: cbBody() });
    await getSolUsdPrice(f, () => NOW);
    await getSolUsdPrice(f, () => NOW + 5_000);
    expect(calls.length).toBe(2); // pyth + coinbase, once
    await getSolUsdPrice(f, () => NOW + 15_000); // TTL elapsed
    expect(calls.length).toBe(4);
  });

  it('rejects malformed bodies', async () => {
    const { f } = fetcher({ pyth: { nope: true }, coinbase: { data: {} } });
    await expect(getSolUsdPrice(f, () => NOW)).rejects.toThrow(/no sol price/);
  });
});

describe('conversion math', () => {
  it("matches Kareem's example: 2 SOL @ $76.52 - 1.5% = $150.7444", () => {
    expect(lamportsToUsdcMicros(2_000_000_000n, 76_520_000n, 150n)).toBe(150_744_400n);
  });

  it('truncates in the platform favor and never goes negative', () => {
    expect(lamportsToUsdcMicros(1n, 76_520_000n, 150n)).toBe(0n); // dust
    expect(lamportsToUsdcMicros(0n, 76_520_000n, 150n)).toBe(0n);
    expect(lamportsToUsdcMicros(-5n, 76_520_000n, 150n)).toBe(0n);
  });

  it('usdToMicro parses and truncates to 6dp', () => {
    expect(usdToMicro('76.52')).toBe(76_520_000n);
    expect(usdToMicro('76')).toBe(76_000_000n);
    expect(usdToMicro('0.1234567')).toBe(123_456n);
    expect(() => usdToMicro('abc')).toThrow();
  });

  it('spread env is clamped', () => {
    process.env.BIDIT_SOL_SPREAD_BPS = '150';
    expect(solSpreadBps()).toBe(150n);
    process.env.BIDIT_SOL_SPREAD_BPS = '99999';
    expect(solSpreadBps()).toBe(1000n);
    process.env.BIDIT_SOL_SPREAD_BPS = '-5';
    expect(solSpreadBps()).toBe(0n);
    process.env.BIDIT_SOL_SPREAD_BPS = 'garbage';
    expect(solSpreadBps()).toBe(150n);
  });
});
