/**
 * Countries BIDit ships between: the dropdown the forms show and the
 * normalizer the backend prices with, from one table so they cannot drift.
 *
 * Codes are ISO 3166-1 alpha-2, which is what carriers require. The list is
 * deliberately curated rather than every country on earth: each entry is a
 * place a parcel can plausibly be rated to through the connected carrier
 * accounts, and a shorter honest list beats 250 options that mostly fail at
 * the rate call.
 */

export interface Country {
  code: string;
  name: string;
}

/** Primary market first, then alphabetical. */
export const COUNTRIES: Country[] = [
  { code: 'US', name: 'United States' },
  { code: 'CA', name: 'Canada' },
  { code: 'AU', name: 'Australia' },
  { code: 'AT', name: 'Austria' },
  { code: 'BE', name: 'Belgium' },
  { code: 'BR', name: 'Brazil' },
  { code: 'CL', name: 'Chile' },
  { code: 'CO', name: 'Colombia' },
  { code: 'CZ', name: 'Czechia' },
  { code: 'DK', name: 'Denmark' },
  { code: 'EG', name: 'Egypt' },
  { code: 'FI', name: 'Finland' },
  { code: 'FR', name: 'France' },
  { code: 'DE', name: 'Germany' },
  { code: 'GR', name: 'Greece' },
  { code: 'HK', name: 'Hong Kong' },
  { code: 'HU', name: 'Hungary' },
  { code: 'IN', name: 'India' },
  { code: 'ID', name: 'Indonesia' },
  { code: 'IE', name: 'Ireland' },
  { code: 'IL', name: 'Israel' },
  { code: 'IT', name: 'Italy' },
  { code: 'JP', name: 'Japan' },
  { code: 'MY', name: 'Malaysia' },
  { code: 'MX', name: 'Mexico' },
  { code: 'NL', name: 'Netherlands' },
  { code: 'NZ', name: 'New Zealand' },
  { code: 'NG', name: 'Nigeria' },
  { code: 'NO', name: 'Norway' },
  { code: 'PE', name: 'Peru' },
  { code: 'PH', name: 'Philippines' },
  { code: 'PL', name: 'Poland' },
  { code: 'PT', name: 'Portugal' },
  { code: 'QA', name: 'Qatar' },
  { code: 'RO', name: 'Romania' },
  { code: 'SA', name: 'Saudi Arabia' },
  { code: 'SG', name: 'Singapore' },
  { code: 'ZA', name: 'South Africa' },
  { code: 'KR', name: 'South Korea' },
  { code: 'ES', name: 'Spain' },
  { code: 'SE', name: 'Sweden' },
  { code: 'CH', name: 'Switzerland' },
  { code: 'TW', name: 'Taiwan' },
  { code: 'TH', name: 'Thailand' },
  { code: 'TR', name: 'Türkiye' },
  { code: 'UA', name: 'Ukraine' },
  { code: 'AE', name: 'United Arab Emirates' },
  { code: 'GB', name: 'United Kingdom' },
  { code: 'VN', name: 'Vietnam' },
];

/** Spellings people actually type, beyond the canonical names above. */
const EXTRA_ALIASES: Record<string, string> = {
  CAN: 'CA',
  'UNITED STATES OF AMERICA': 'US', USA: 'US', AMERICA: 'US',
  UK: 'GB', 'GREAT BRITAIN': 'GB', BRITAIN: 'GB',
  ENGLAND: 'GB', SCOTLAND: 'GB', WALES: 'GB', 'NORTHERN IRELAND': 'GB',
  'THE NETHERLANDS': 'NL', HOLLAND: 'NL',
  'CZECH REPUBLIC': 'CZ',
  KOREA: 'KR',
  TURKEY: 'TR',
  UAE: 'AE',
};

const CODE_BY_NAME: Record<string, string> = Object.fromEntries([
  ...COUNTRIES.map((c) => [c.name.toUpperCase(), c.code]),
  ...Object.entries(EXTRA_ALIASES),
]);

const VALID_CODES = new Set(COUNTRIES.map((c) => c.code));

/**
 * Free text in, ISO alpha-2 out, or null when the text is not a country we
 * recognise. Never truncates: "Germany".slice(0, 2) is GE, which is Georgia's
 * code, and a wrong country prices a parcel to the wrong place without anyone
 * noticing. Unknown must fail visibly, not approximately succeed.
 */
export function normalizeCountry(input?: string | null): string | null {
  const c = (input ?? '').trim().toUpperCase();
  if (!c) return null;
  const byName = CODE_BY_NAME[c];
  if (byName) return byName;
  if (/^[A-Z]{2}$/.test(c)) return c; // a code already, ours or not
  return null;
}

export function isKnownCountry(code: string): boolean {
  return VALID_CODES.has(code.toUpperCase());
}
