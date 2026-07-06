import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useSeller } from '../../components/SellerLayout';
import { setSellerCoin, saveStreamSettings, type Session } from '../../api';
import { Check, ArrowRight } from '../../icons';
import ShippingSettingsCard from '../../components/seller/ShippingSettingsCard';
import { CATEGORIES } from '../../data';

export default function Settings() {
  const { session, setSession } = useSeller();
  const [coin, setCoin] = useState(session.pumpCoinAddress ?? '');
  const [title, setTitle] = useState(session.streamTitle ?? '');
  const [category, setCategory] = useState(session.streamCategory ?? '');
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  const save = async () => {
    setBusy(true);
    try {
      // Coin is validated by its own endpoint; only push it when it changed.
      if (coin.trim() && coin.trim() !== (session.pumpCoinAddress ?? '')) {
        await setSellerCoin(coin.trim());
      }
      const next: Session = await saveStreamSettings({
        streamTitle: title.trim() || null,
        streamCategory: category || null,
      });
      setSession(next); // fresh session reflects coin + title + category
      setSaved(true);
      setTimeout(() => setSaved(false), 2200);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="acct-head">
        <h1 className="display acct-title">Seller settings</h1>
        <p className="muted">Connect the stream you sell on and manage your shop.</p>
      </div>

      <div className="card acct-card">
        <h3 className="acct-sub">Livestream</h3>
        <p className="muted acct-note">Link the coin you stream on — buyers who open its page see your live BIDit auctions. Give your stream a title and category so it stands out on the live grid.</p>
        <div className="fld"><label>Coin address</label><input value={coin} onChange={(e) => setCoin(e.target.value)} placeholder="Paste your pump.fun coin address" /></div>
        <div className="fld-row">
          <div className="fld">
            <label>Stream title</label>
            <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={80} placeholder="e.g. Friday Night Rips — $1 starts" />
          </div>
          <div className="fld">
            <label>Category</label>
            <select value={category} onChange={(e) => setCategory(e.target.value)}>
              <option value="">No category</option>
              {CATEGORIES.map((c) => <option key={c.name} value={c.name}>{c.name}</option>)}
            </select>
          </div>
        </div>
        <p className="muted acct-note" style={{ marginTop: 0 }}>Leave the title blank to show your coin name instead.</p>
        <div className="acct-actions">
          <button className="btn btn-primary" onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save livestream'}</button>
          {saved && <span className="acct-saved"><Check width={16} height={16} /> Saved</span>}
        </div>
      </div>

      <ShippingSettingsCard session={session} setSession={setSession} />

      <div className="card acct-card">
        <h3 className="acct-sub">Verification</h3>
        <div className="verify-row">
          <span className="verify-badge"><Check width={15} height={15} /> Verified seller</span>
          <span className="muted">Beta auto-approval · KYC arrives with mainnet.</span>
        </div>
      </div>

      <div className="card acct-card set-link">
        <div><h3 className="acct-sub" style={{ marginBottom: 4 }}>Shop profile</h3><p className="muted">Edit your name, avatar and bio buyers see.</p></div>
        <Link className="btn btn-ghost" to="/profile">Edit profile <ArrowRight width={16} height={16} /></Link>
      </div>
    </>
  );
}
