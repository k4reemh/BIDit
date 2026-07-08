import { useState } from 'react';
import { saveShippingSettings, refreshMe, type Session } from '../../api';
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
  const [country, setCountry] = useState(s?.originCountry ?? '');
  const [region, setRegion] = useState(s?.originRegion ?? '');
  const [city, setCity] = useState(s?.originCity ?? '');
  const [postal, setPostal] = useState(s?.originPostal ?? '');
  const [weekly, setWeekly] = useState(s?.weeklyBundling ?? false);
  const [shipLater, setShipLater] = useState(s?.shipLater ?? false);
  const [priv, setPriv] = useState(s?.privateShipping ?? false);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  const save = async () => {
    setBusy(true);
    try {
      await saveShippingSettings({
        originCountry: country.trim() || null,
        originRegion: region.trim() || null,
        originCity: city.trim() || null,
        originPostal: postal.trim() || null,
        weeklyBundling: weekly,
        shipLater,
        privateShipping: priv,
      });
      setSession(await refreshMe());
      setSaved(true);
      setTimeout(() => setSaved(false), 2200);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card acct-card">
      <h3 className="acct-sub">Shipping</h3>
      <p className="muted acct-note">Where you ship from (used to estimate buyers’ shipping) and which options you offer.</p>

      <div className="fld-row">
        <div className="fld"><label>Country</label><input value={country} onChange={(e) => setCountry(e.target.value)} placeholder="US, CA…" /></div>
        <div className="fld"><label>State / Region</label><input value={region} onChange={(e) => setRegion(e.target.value)} placeholder="CA, AB…" /></div>
      </div>
      <div className="fld-row">
        <div className="fld"><label>City</label><input value={city} onChange={(e) => setCity(e.target.value)} placeholder="City" /></div>
        <div className="fld"><label>Postal / ZIP</label><input value={postal} onChange={(e) => setPostal(e.target.value)} placeholder="ZIP / postal" /></div>
      </div>

      <div className="ship-opts">
        <label className="ship-priv">
          <input type="checkbox" checked={weekly} onChange={(e) => setWeekly(e.target.checked)} />
          <span><b>Weekly bundling</b> — buyers pay shipping once a week and you ship their wins together.</span>
        </label>
        <label className="ship-priv">
          <input type="checkbox" checked={shipLater} onChange={(e) => setShipLater(e.target.checked)} />
          <span><b>Buy now, ship later</b> — hold buyers’ wins up to 14 days so they can bundle before shipping.</span>
        </label>
        <label className="ship-priv">
          <input type="checkbox" checked={priv} onChange={(e) => setPriv(e.target.checked)} />
          <span><b>Private secure shipping</b> — buyers can hide their address; you ship to BIDit and we forward it.</span>
        </label>
      </div>

      <div className="acct-actions">
        <button className="btn btn-primary" onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save shipping'}</button>
        {saved && <span className="acct-saved"><Check width={16} height={16} /> Saved</span>}
      </div>
    </div>
  );
}
