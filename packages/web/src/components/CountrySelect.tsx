import { COUNTRIES, normalizeCountry } from '@bidit/shared';

/**
 * Country picker for every address form.
 *
 * Free-text country fields were feeding the carrier whatever people typed, and
 * a typo does not fail loudly: it rates against the wrong country or against
 * none, weeks before anyone finds out at label time. A dropdown makes the only
 * expressible values the ones the pricer understands.
 *
 * The stored value is the ISO code. Addresses saved before this existed hold
 * free text ("Canada"), so the current value is normalised before matching: an
 * old address shows its country selected rather than blank.
 */
export default function CountrySelect({
  value,
  onChange,
  id,
}: {
  value: string;
  onChange: (code: string) => void;
  id?: string;
}) {
  const selected = normalizeCountry(value) ?? '';
  return (
    <select id={id} className="country-select" value={selected} onChange={(e) => onChange(e.target.value)}>
      <option value="" disabled>
        Select country…
      </option>
      {COUNTRIES.map((c) => (
        <option key={c.code} value={c.code}>
          {c.name}
        </option>
      ))}
    </select>
  );
}
