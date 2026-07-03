import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useSeller } from '../../components/SellerLayout';
import { setSellerCoin, refreshMe } from '../../api';
import { Check, ArrowRight } from '../../icons';
import ShippingSettingsCard from '../../components/seller/ShippingSettingsCard';

export default function Settings() {
  const { session, setSession } = useSeller();
  const [coin, setCoin] = useState(session.pumpCoinAddress ?? '');
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  const save = async () => {
    setBusy(true);
    try {
      await setSellerCoin(coin.trim());
      setSession(await refreshMe()); // persist into session so it shows saved on return
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
        <h3 className="acct-sub">Pump.fun coin</h3>
        <p className="muted acct-note">Link the coin you stream on — buyers who open its page see your live BIDit auctions.</p>
        <div className="fld"><label>Coin address</label><input value={coin} onChange={(e) => setCoin(e.target.value)} placeholder="Paste your pump.fun coin address" /></div>
        <div className="acct-actions">
          <button className="btn btn-primary" onClick={save} disabled={!coin.trim() || busy}>{busy ? 'Saving…' : 'Save coin'}</button>
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
