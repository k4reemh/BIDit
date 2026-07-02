/**
 * Money primitives.
 *
 * Everything financial in BIDit is an integer number of USDC micro-units
 * (6 decimals), represented as a `bigint`. Never use floats for money. The
 * `Micros` brand is just `bigint` — kept as an alias for readability.
 */

export type Micros = bigint;

export const USDC_DECIMALS = 6;
export const MICROS_PER_USDC = 1_000_000n;

/** Platform cut, in basis points. 500 bps = 5%. Funds the $BID buyback wallet. */
export const PLATFORM_FEE_BPS = 500n;
export const BPS_DENOMINATOR = 10_000n;

/**
 * Parse a human USDC amount into micro-units.
 *   usdc('10.50') -> 10_500_000n
 *   usdc(25)      -> 25_000_000n
 * Rejects more than 6 decimal places (would lose precision silently).
 */
export function usdc(value: string | number): Micros {
  const s = typeof value === 'number' ? numberToDecimalString(value) : value.trim();
  return parseDecimalToMicros(s, USDC_DECIMALS);
}

function numberToDecimalString(value: number): string {
  if (!Number.isFinite(value)) {
    throw new RangeError(`Cannot convert non-finite number to USDC: ${value}`);
  }
  // toFixed avoids scientific notation and pins to our precision.
  return value.toFixed(USDC_DECIMALS);
}

function parseDecimalToMicros(input: string, decimals: number): Micros {
  const match = /^(-)?(\d+)(?:\.(\d+))?$/.exec(input);
  if (!match) {
    throw new RangeError(`Invalid USDC amount: "${input}"`);
  }
  const negative = match[1] === '-';
  const intPart = match[2]!;
  const fracPart = match[3] ?? '';
  if (fracPart.length > decimals) {
    throw new RangeError(
      `Too many decimal places in "${input}" (max ${decimals} for USDC)`,
    );
  }
  const fracPadded = fracPart.padEnd(decimals, '0');
  const scale = 10n ** BigInt(decimals);
  const micros = BigInt(intPart) * scale + BigInt(fracPadded === '' ? '0' : fracPadded);
  return negative ? -micros : micros;
}

/**
 * Format micro-units back to a human decimal string (trailing zeros trimmed).
 *   formatUsdc(10_500_000n) -> '10.5'
 *   formatUsdc(25_000_000n) -> '25'
 */
export function formatUsdc(micros: Micros): string {
  const negative = micros < 0n;
  const abs = negative ? -micros : micros;
  const scale = 10n ** BigInt(USDC_DECIMALS);
  const whole = abs / scale;
  const frac = (abs % scale).toString().padStart(USDC_DECIMALS, '0').replace(/0+$/, '');
  const body = frac.length > 0 ? `${whole}.${frac}` : `${whole}`;
  return negative ? `-${body}` : body;
}

/**
 * Split a winning bid into platform fee + seller proceeds.
 *
 * Integer math with floor on the fee, then proceeds = amount - fee. Because
 * proceeds is computed as the remainder, fee + proceeds === amount exactly —
 * no rounding leak, money is conserved to the micro-unit.
 */
export function splitAmount(
  amount: Micros,
  feeBps: bigint = PLATFORM_FEE_BPS,
): { platformFee: Micros; sellerProceeds: Micros } {
  if (amount < 0n) {
    throw new RangeError(`Cannot split a negative amount: ${amount}`);
  }
  if (feeBps < 0n || feeBps > BPS_DENOMINATOR) {
    throw new RangeError(`feeBps out of range [0, ${BPS_DENOMINATOR}]: ${feeBps}`);
  }
  const platformFee = (amount * feeBps) / BPS_DENOMINATOR; // floor
  const sellerProceeds = amount - platformFee;
  return { platformFee, sellerProceeds };
}
