import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useSeller } from '../../components/SellerLayout';
import { setSellerCoin, saveStreamSettings, type Session } from '../../api';
import { Check, ArrowRight, Verified } from '../../icons';
import ShippingSettingsCard from '../../components/seller/ShippingSettingsCard';
import CreateCoinCard from '../../components/seller/CreateCoinCard';
import ImageUpload from '../../components/ImageUpload';
import { CATEGORIES } from '../../data';

export default function Settings() {
  const { session, setSession } = useSeller();
  const [coin, setCoin] = useState(session.pumpCoinAddress ?? '');
  const [title, setTitle] = useState(session.streamTitle ?? '');
  const [category, setCategory] = useState(session.streamCategory ?? '');
  const [image, setImage] = useState(session.streamImage ?? '');
  const [cooldown, setCooldown] = useState(session.chatCooldownMs ?? 5000);
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
        streamImage: image || null,
        chatCooldownMs: cooldown,
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
        <p className="muted acct-note">Link the coin you stream on. Buyers who open its page see your live BIDit auctions. Give your stream a title and category so it stands out on the live grid.</p>
        {/* Renders the create button, or the linked panel (address + coin-page
            link) once there is a coin. onLinked keeps the field below in step
            with a coin created right here — it was seeded on mount, so without
            this it would sit empty and look unsaved. */}
        <CreateCoinCard session={session} setSession={setSession} onLinked={setCoin} />
        <div className="fld">
          <label>Coin address {!session.pumpCoinAddress && <span className="muted">(or paste one you already have)</span>}</label>
          <input value={coin} onChange={(e) => setCoin(e.target.value)} placeholder="Paste your pump.fun coin address" />
          {session.pumpCoinAddress && (
            <span className="muted" style={{ fontSize: 12, marginTop: 4 }}>
              A linked coin can only be moved to another seller by support. Clearing it here just unlinks it from your shop.
            </span>
          )}
        </div>
        <div className="fld-row">
          <div className="fld">
            <label>Stream title</label>
            <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={80} placeholder="e.g. Friday Night Rips: $1 starts" />
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
        <div className="fld">
          <ImageUpload
            value={image}
            onChange={setImage}
            label="Cover image"
            hint="Shown on your card in the live grid. Landscape works best. Without one we use the item you’re auctioning, then your coin art."
          />
        </div>
        <div className="fld">
          <label>Live chat cooldown</label>
          <select value={cooldown} onChange={(e) => setCooldown(Number(e.target.value))}>
            <option value={0}>Off (no limit)</option>
            <option value={3000}>3 seconds between messages</option>
            <option value={5000}>5 seconds between messages</option>
            <option value={10000}>10 seconds between messages</option>
            <option value={30000}>30 seconds between messages</option>
          </select>
          <p className="muted acct-note" style={{ marginTop: 6 }}>How long each viewer waits between chat messages on your coin page. Turn it up to slow a busy or spammy chat.</p>
        </div>
        <div className="acct-actions">
          <button className="btn btn-primary" onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save livestream'}</button>
          {saved && <span className="acct-saved"><Check width={16} height={16} /> Saved</span>}
        </div>
      </div>

      <ShippingSettingsCard session={session} setSession={setSession} />

      <div className="card acct-card">
        <h3 className="acct-sub">Verification</h3>
        {/* Real status, not a decoration: the badge is earned at
            `verifyThreshold` fulfilled orders (or granted by an admin). */}
        <div className="verify-row">
          {session.verified ? (
            <>
              <span className="verify-badge"><Verified width={15} height={15} /> Verified seller</span>
              <span className="muted">Buyers see this badge on your stream and your cards.</span>
            </>
          ) : (
            <>
              <span className="verify-badge vbadge--pending"><Check width={15} height={15} /> Not verified yet</span>
              <span className="muted">
                Fulfill {session.verifyThreshold ?? 10} orders to earn the badge. You&rsquo;re at{' '}
                <b>{session.fulfilledCount ?? 0}</b>.
              </span>
            </>
          )}
        </div>
      </div>

      <div className="card acct-card set-link">
        <div><h3 className="acct-sub" style={{ marginBottom: 4 }}>Shop profile</h3><p className="muted">Edit your name, avatar and bio buyers see.</p></div>
        <Link className="btn btn-ghost" to="/profile">Edit profile <ArrowRight width={16} height={16} /></Link>
      </div>
    </>
  );
}
