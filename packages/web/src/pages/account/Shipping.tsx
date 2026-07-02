import { useState } from 'react';
import { useAccount } from '../../components/AccountLayout';
import { updateMe } from '../../api';
import { Check } from '../../icons';

const EMPTY = { name: '', line1: '', line2: '', city: '', region: '', postal: '', country: '' };

export default function Shipping() {
  const { session, setSession } = useAccount();
  const [f, setF] = useState({ ...EMPTY, ...(session.shippingAddress ?? {}) });
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });

  const valid = f.name && f.line1 && f.city && f.postal && f.country;

  const save = async () => {
    setBusy(true);
    try {
      setSession(await updateMe({ shippingAddress: { ...f } }));
      setSaved(true);
      setTimeout(() => setSaved(false), 2200);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="acct-head">
        <h1 className="display acct-title">Payments &amp; shipping</h1>
        <p className="muted">Where we send the cards you win, and how you get paid.</p>
      </div>

      <div className="card acct-card">
        <h3 className="acct-sub">Shipping address</h3>
        <div className="fld">
          <label>Full name</label>
          <input value={f.name} onChange={set('name')} placeholder="Kareem A." />
        </div>
        <div className="fld">
          <label>Address line 1</label>
          <input value={f.line1} onChange={set('line1')} placeholder="123 Main St" />
        </div>
        <div className="fld">
          <label>Address line 2 <span className="muted">— optional</span></label>
          <input value={f.line2} onChange={set('line2')} placeholder="Apt, suite, unit" />
        </div>
        <div className="fld-row">
          <div className="fld"><label>City</label><input value={f.city} onChange={set('city')} placeholder="Calgary" /></div>
          <div className="fld"><label>Province / State</label><input value={f.region} onChange={set('region')} placeholder="AB" /></div>
        </div>
        <div className="fld-row">
          <div className="fld"><label>Postal / ZIP</label><input value={f.postal} onChange={set('postal')} placeholder="T2P 1J9" /></div>
          <div className="fld"><label>Country</label><input value={f.country} onChange={set('country')} placeholder="Canada" /></div>
        </div>
        <div className="acct-actions">
          <button className="btn btn-primary" onClick={save} disabled={!valid || busy}>
            {busy ? 'Saving…' : 'Save address'}
          </button>
          {saved && <span className="acct-saved"><Check width={16} height={16} /> Saved</span>}
        </div>
      </div>

      <div className="card acct-card">
        <h3 className="acct-sub">Payouts</h3>
        <p className="muted acct-note">Sellers are paid in USDC to their connected wallet. Connect a payout wallet when you start selling.</p>
        <button className="btn btn-ghost" disabled>Connect payout wallet · soon</button>
      </div>
    </>
  );
}
