import { useState } from 'react';
import { saveShippingSettings, refreshMe, validateAddress, type Session, type AddressCheck } from '../../api';
import AddressCheckNote from '../AddressCheckNote';
import CountrySelect from '../CountrySelect';
import { Check } from '../../icons';

/** Seller ship-from origin (drives shipping quotes) + which shipping modes they
 *  offer buyers on their page. */
export default function ShippingSettingsCard({
  session,
  setSession,
}: {
  session: Session;
  setSession: (s: Session) => void;
}) {
  const s = session.shipping;
  const [name, setName] = useState(s?.originName ?? '');
  const [line1, setLine1] = useState(s?.originLine1 ?? '');
  const [line2, setLine2] = useState(s?.originLine2 ?? '');
  const [country, setCountry] = useState(s?.originCountry ?? '');
  const [region, setRegion] = useState(s?.originRegion ?? '');
  const [city, setCity] = useState(s?.originCity ?? '');
  const [postal, setPostal] = useState(s?.originPostal ?? '');
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [check, setCheck] = useState<AddressCheck | null>(null);

  const save = async () => {
    setBusy(true);
    setCheck(null);
    try {
      await saveShippingSettings({
        originName: name.trim() || null,
        originLine1: line1.trim() || null,
        originLine2: line2.trim() || null,
        originCountry: country.trim() || null,
        originRegion: region.trim() || null,
        originCity: city.trim() || null,
        originPostal: postal.trim() || null,
      });
      setSession(await refreshMe());
      setSaved(true);
      setTimeout(() => setSaved(false), 2200);
      // Advisory, after the save. A ship-from the carrier cannot place is worth
      // knowing about now rather than when a label refuses to print.
      setCheck(
        await validateAddress({
          name: name.trim(), line1: line1.trim(), city: city.trim(),
          region: region.trim(), postal: postal.trim(), country: country.trim(),
        }).catch(() => null),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card acct-card">
      <h3 className="acct-sub">Shipping</h3>
      <p className="muted acct-note">Your return address. It prints on your shipping labels and sets the shipping cost buyers see. Buyers never see it.</p>

      <div className="fld"><label>Full name</label><input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name on the label" /></div>
      <div className="fld"><label>Street address</label><input value={line1} onChange={(e) => setLine1(e.target.value)} placeholder="123 Main St" /></div>
      <div className="fld"><label>Apt, suite, unit <span className="muted">(optional)</span></label><input value={line2} onChange={(e) => setLine2(e.target.value)} placeholder="Unit 4" /></div>

      <div className="fld-row">
        <div className="fld"><label>Country</label><CountrySelect value={country} onChange={setCountry} /></div>
        <div className="fld"><label>State / Region</label><input value={region} onChange={(e) => setRegion(e.target.value)} placeholder="CA, AB…" /></div>
      </div>
      <div className="fld-row">
        <div className="fld"><label>City</label><input value={city} onChange={(e) => setCity(e.target.value)} placeholder="City" /></div>
        <div className="fld"><label>Postal / ZIP</label><input value={postal} onChange={(e) => setPostal(e.target.value)} placeholder="ZIP / postal" /></div>
      </div>

      <AddressCheckNote
        check={check}
        onApply={(sug) => {
          if (sug.line1) setLine1(sug.line1);
          if (sug.city) setCity(sug.city);
          if (sug.region) setRegion(sug.region);
          if (sug.postal) setPostal(sug.postal);
          setCheck(null);
        }}
      />

      {/* The weekly-bundling / ship-later / private toggles lived here. Buyer
          shipping modes are platform-run now (ship-later is everyone's default,
          private is the buyer's choice at ship time, charge-on-win is gated
          off), so a seller checkbox only promised behaviour the seller no
          longer controls. */}

      <div className="acct-actions">
        <button className="btn btn-primary" onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save shipping'}</button>
        {saved && <span className="acct-saved"><Check width={16} height={16} /> Saved</span>}
      </div>
    </div>
  );
}
