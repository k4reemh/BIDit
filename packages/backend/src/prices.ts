/**
 * SOL/USD price oracle for SOL deposits.
 *
 * Credits are real money, so a price is only trusted when it survives the
 * guards here:
 *   - Primary source: Pyth (Hermes REST), the same oracle Solana DeFi settles
 *     against. Rejected when stale (> PRICE_MAX_AGE_S).
 *   - Cross-check: Coinbase spot. When both sources answer they must agree
 *     within DIVERGENCE_LIMIT_BPS or we refuse to price at all (a wrong credit
 *     is worse than a delayed one; the watcher just retries next tick).
 *   - Either source alone is acceptable when the other is down (logged), both
 *     down ⇒ no price ⇒ no crediting.
 *
 * Prices are bigint micro-USD per whole SOL (e.g. $76.52 ⇒ 76_520_000n), so
 * lamports → USDC micro-units conversion stays in integer math end to end.
 */

const PYTH_SOL_USD_FEED = 'ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d';
const PYTH_URL = `https://hermes.pyth.network/v2/updates/price/latest?ids[]=${PYTH_SOL_USD_FEED}&parsed=true`;
const COINBASE_URL = 'https://api.coinbase.com/v2/prices/SOL-USD/spot';

const PRICE_MAX_AGE_S = 90; // Pyth publish_time older than this ⇒ stale
const DIVERGENCE_LIMIT_BPS = 200n; // sources >2% apart ⇒ refuse to price
const CACHE_TTL_MS = 10_000;
const FETCH_TIMEOUT_MS = 4_000;

/** Conversion spread in basis points (default 1.5%), clamped to [0, 10%]. */
export function solSpreadBps(): bigint {
  const raw = Number(process.env.BIDIT_SOL_SPREAD_BPS ?? 150);
  if (!Number.isFinite(raw)) return 150n;
  return BigInt(Math.min(1000, Math.max(0, Math.floor(raw))));
}

export interface SolPrice {
  /** micro-USD per 1 SOL */
  usdMicro: bigint;
  /** which sources vouched for it */
  source: 'pyth+coinbase' | 'pyth' | 'coinbase';
  at: number;
}

type Fetcher = typeof fetch;

async function fetchJson(fetcher: Fetcher, url: string): Promise<unknown> {
  const res = await fetcher(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`${url} → ${res.status}`);
  return res.json();
}

/** Pyth price record → micro-USD bigint. price * 10^expo USD per SOL. */
function pythToMicro(price: string, expo: number): bigint {
  const e = expo + 6;
  const v = BigInt(price);
  return e >= 0 ? v * 10n ** BigInt(e) : v / 10n ** BigInt(-e);
}

/** "76.52" → 76_520_000n (micro-USD), truncating past 6 dp. */
export function usdToMicro(s: string): bigint {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(s.trim());
  if (!m) throw new Error(`bad USD amount: ${s}`);
  const frac = (m[2] ?? '').slice(0, 6).padEnd(6, '0');
  return BigInt(m[1]!) * 1_000_000n + BigInt(frac);
}

async function fromPyth(fetcher: Fetcher, nowS: number): Promise<bigint> {
  const body = (await fetchJson(fetcher, PYTH_URL)) as {
    parsed?: { price?: { price?: string; expo?: number; publish_time?: number } }[];
  };
  const p = body.parsed?.[0]?.price;
  if (!p?.price || typeof p.expo !== 'number' || typeof p.publish_time !== 'number') {
    throw new Error('pyth: malformed response');
  }
  if (nowS - p.publish_time > PRICE_MAX_AGE_S) throw new Error(`pyth: stale (${nowS - p.publish_time}s old)`);
  const micro = pythToMicro(p.price, p.expo);
  if (micro <= 0n) throw new Error('pyth: non-positive price');
  return micro;
}

async function fromCoinbase(fetcher: Fetcher): Promise<bigint> {
  const body = (await fetchJson(fetcher, COINBASE_URL)) as { data?: { amount?: string } };
  if (!body.data?.amount) throw new Error('coinbase: malformed response');
  const micro = usdToMicro(body.data.amount);
  if (micro <= 0n) throw new Error('coinbase: non-positive price');
  return micro;
}

let cached: SolPrice | null = null;

/** Test hook: drop the cache. */
export function clearPriceCache(): void {
  cached = null;
}

/**
 * Current SOL/USD price, guarded as documented above. Throws when no
 * trustworthy price exists — callers must treat that as "don't credit yet".
 */
export async function getSolUsdPrice(
  fetcher: Fetcher = fetch,
  now: () => number = Date.now,
): Promise<SolPrice> {
  if (cached && now() - cached.at < CACHE_TTL_MS) return cached;

  const nowS = Math.floor(now() / 1000);
  const [pyth, coinbase] = await Promise.allSettled([fromPyth(fetcher, nowS), fromCoinbase(fetcher)]);

  let price: SolPrice;
  if (pyth.status === 'fulfilled' && coinbase.status === 'fulfilled') {
    const a = pyth.value;
    const b = coinbase.value;
    const max = a > b ? a : b;
    const diff = a > b ? a - b : b - a;
    if (diff * 10_000n > DIVERGENCE_LIMIT_BPS * max) {
      throw new Error(`sol price divergent: pyth=${a} coinbase=${b}`);
    }
    price = { usdMicro: a, source: 'pyth+coinbase', at: now() };
  } else if (pyth.status === 'fulfilled') {
    console.warn(`[prices] coinbase down (${String((coinbase as PromiseRejectedResult).reason)}), using pyth alone`);
    price = { usdMicro: pyth.value, source: 'pyth', at: now() };
  } else if (coinbase.status === 'fulfilled') {
    console.warn(`[prices] pyth down (${String((pyth as PromiseRejectedResult).reason)}), using coinbase alone`);
    price = { usdMicro: coinbase.value, source: 'coinbase', at: now() };
  } else {
    throw new Error(
      `no sol price: pyth=${String((pyth as PromiseRejectedResult).reason)} coinbase=${String((coinbase as PromiseRejectedResult).reason)}`,
    );
  }
  cached = price;
  return price;
}

/**
 * lamports → USDC micro-units at `usdMicro` per SOL minus `spreadBps`.
 * Integer math, truncation rounds in the platform's favor.
 */
export function lamportsToUsdcMicros(lamports: bigint, usdMicro: bigint, spreadBps: bigint = solSpreadBps()): bigint {
  if (lamports <= 0n) return 0n;
  return (lamports * usdMicro * (10_000n - spreadBps)) / (1_000_000_000n * 10_000n);
}
