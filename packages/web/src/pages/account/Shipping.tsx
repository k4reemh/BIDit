import { useEffect, useState } from 'react';
import { useAccount } from '../../components/AccountLayout';
import { updateMe, validateAddress, type AddressCheck } from '../../api';
import AddressCheckNote from '../../components/AddressCheckNote';
import { Check } from '../../icons';

const EMPTY = { name: '', line1: '', line2: '', city: '', region: '', postal: '', country: '' };

export default function Shipping() {
  const { session, setSession } = useAccount();
  const [f, setF] = useState({ ...EMPTY, ...(session.shippingAddress ?? {}) });
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [check, setCheck] = useState<AddressCheck | null>(null);

  // Check whatever is already on file, once, on load. Addresses entered during
  // onboarding never pass through the save path below, and that flow advances
  // too fast to show a warning in, so this is where they get looked at.
  useEffect(() => {
    const a = session.shippingAddress;
    if (!a?.line1 || !a?.country) return;
    let live = true;
    validateAddress(a).then((c) => { if (live) setCheck(c); }).catch(() => {});
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });

  const valid = f.name && f.line1 && f.city && f.postal && f.country;

  const save = async () => {
    setBusy(true);
    setCheck(null);
    try {
      // Save first, always. The carrier check is advice, and a carrier database
      // that has not heard of someone's street is not a reason to stop them
      // entering where they live.
      setSession(await updateMe({ shippingAddress: { ...f } }));
      setSaved(true);
      setTimeout(() => setSaved(false), 2200);
      setCheck(await validateAddress(f).catch(() => null));
    } finally {
      setBusy(false);
    }
  };

  const applySuggestion = (s: NonNullable<AddressCheck['suggestion']>) => {
    const next = { ...f, ...Object.fromEntries(Object.entries(s).filter(([, v]) => v)) };
    setF(next);
    setCheck(null);
    void updateMe({ shippingAddress: next }).then(setSession);
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
          <label>Address line 2 <span className="muted">(optional)</span></label>
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
        <AddressCheckNote check={check} onApply={applySuggestion} />
        <div className="acct-actions">
          <button className="btn btn-primary" onClick={save} disabled={!valid || busy}>
            {busy ? 'Saving…' : 'Save address'}
          </button>
          {saved && <span className="acct-saved"><Check width={16} height={16} /> Saved</span>}
        </div>
      </div>

      <div className="card acct-card">
        <h3 className="acct-sub">Payouts</h3>
        <p className="muted acct-note">Sellers get paid in USDC to their connected wallet. Connect yours when you start selling.</p>
        <button className="btn btn-ghost" disabled>Connect payout wallet · soon</button>
      </div>
    </>
  );
}
