// Turn a seller's ship-from country (a 2-letter ISO code like "US", or a common
// name like "United States") into a flag emoji + tidy label for the live cards.
// Sellers type this freehand in settings, so we accept codes and common names.

const NAME_TO_ISO: Record<string, string> = {
  'united states': 'US', 'united states of america': 'US', usa: 'US', us: 'US', america: 'US',
  canada: 'CA', ca: 'CA',
  'united kingdom': 'GB', uk: 'GB', gb: 'GB', england: 'GB', britain: 'GB', 'great britain': 'GB', scotland: 'GB', wales: 'GB',
  australia: 'AU', au: 'AU',
  germany: 'DE', deutschland: 'DE', de: 'DE',
  france: 'FR', fr: 'FR',
  japan: 'JP', jp: 'JP',
  netherlands: 'NL', holland: 'NL', nl: 'NL',
  italy: 'IT', it: 'IT',
  spain: 'ES', es: 'ES',
  ireland: 'IE', ie: 'IE',
  singapore: 'SG', sg: 'SG',
  philippines: 'PH', ph: 'PH',
  mexico: 'MX', mx: 'MX',
  brazil: 'BR', br: 'BR',
  'new zealand': 'NZ', nz: 'NZ',
  'south korea': 'KR', korea: 'KR', kr: 'KR',
  'hong kong': 'HK', hk: 'HK',
  china: 'CN', cn: 'CN',
  india: 'IN', in: 'IN',
  sweden: 'SE', se: 'SE',
  norway: 'NO', no: 'NO',
  denmark: 'DK', dk: 'DK',
  belgium: 'BE', be: 'BE',
  poland: 'PL', pl: 'PL',
  portugal: 'PT', pt: 'PT',
  switzerland: 'CH', ch: 'CH',
  austria: 'AT', at: 'AT',
  'united arab emirates': 'AE', uae: 'AE', ae: 'AE',
};

/** ISO-3166 alpha-2 → 🇺🇸-style flag via regional-indicator code points. */
function isoToFlag(iso: string): string {
  return iso
    .toUpperCase()
    .replace(/[^A-Z]/g, '')
    .replace(/./g, (c) => String.fromCodePoint(127397 + c.charCodeAt(0)));
}

/** Resolve a freehand country string to a flag + display code, or null if we can't. */
export function countryFlag(input?: string | null): { flag: string; code: string } | null {
  if (!input) return null;
  const raw = input.trim();
  if (!raw) return null;
  const key = raw.toLowerCase();
  let iso = NAME_TO_ISO[key];
  if (!iso && /^[a-zA-Z]{2}$/.test(raw)) iso = raw.toUpperCase(); // already an ISO code
  if (!iso) return null;
  return { flag: isoToFlag(iso), code: iso };
}
