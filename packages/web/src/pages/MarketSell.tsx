import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { createMarketListingApi, applySeller, refreshMe, MARKET_REGIONS, type Session, type MarketRegion } from '../api';
import ImageUpload from '../components/ImageUpload';
import { CATEGORIES } from '../data';

const DURATIONS = [
  { h: 12, label: '12 hours' },
  { h: 24, label: '24 hours' },
  { h: 48, label: '2 days' },
  { h: 72, label: '3 days' },
  { h: 120, label: '5 days' },
  { h: 168, label: '7 days' },
];
const REGION_LABEL: Record<MarketRegion, string> = {
  US: 'United States', CA: 'Canada', UK: 'United Kingdom', EU: 'Europe', ASIA: 'Asia', OTHER: 'Rest of world',
};

export default function MarketSell({ session, setSession, onAuth }: { session: Session | null; setSession: (s: Session) => void; onAuth: () => void }) {
  const [photos, setPhotos] = useState<string[]>(['']);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState('');
  const [startingBid, setStartingBid] = useState('');
  const [durationHours, setDurationHours] = useState(24);
  const [ship, setShip] = useState<Record<string, string>>({ US: '' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const navigate = useNavigate();

  if (!session) {
    return (
      <main className="container mkt-sell">
        <div className="mkt__empty"><b>Sign in to sell</b><p className="muted">Your listing takes about a minute to set up.</p>
          <button className="btn btn-primary" onClick={onAuth}>Sign in</button></div>
      </main>
    );
  }

  const isSeller = session.role === 'seller' || session.role === 'admin';

  const setPhoto = (i: number, v: string) => {
    setPhotos((prev) => {
      const next = [...prev];
      next[i] = v;
      // Keep one trailing empty slot (max 5 photos).
      const filled = next.filter(Boolean);
      return filled.length < 5 ? [...filled, ''] : filled.slice(0, 5);
    });
  };

  const submit = async () => {
    setErr('');
    setBusy(true);
    try {
      // Selling on the marketplace makes you a seller; approval is instant.
      if (!isSeller) {
        await applySeller();
        setSession(await refreshMe());
      }
      const shipPrices: Record<string, string> = {};
      for (const r of MARKET_REGIONS) {
        const v = (ship[r] ?? '').trim();
        if (v !== '') shipPrices[r] = v;
      }
      const created = await createMarketListingApi({
        title,
        description: description || undefined,
        category: category || undefined,
        photos: photos.filter(Boolean),
        startingBid,
        durationHours,
        shipPrices,
      });
      navigate(`/marketplace/${created.auctionId}`);
    } catch (e) {
      setErr((e as Error).message || 'Could not create the listing.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="container mkt-sell">
      <header className="mkt__head">
        <div>
          <h1 className="display mkt__title">Sell an item</h1>
          <p className="muted">Photos, a starting bid, how long it runs, and what you charge to ship. That&rsquo;s the whole listing.</p>
        </div>
        <Link className="btn btn-ghost" to="/marketplace">Back to marketplace</Link>
      </header>

      <div className="mkt-sell__grid">
        <section className="card acct-card">
          <h3 className="acct-sub">The item</h3>
          <div className="mkt-sell__photos">
            {photos.map((p, i) => (
              <ImageUpload key={i} value={p} onChange={(v) => setPhoto(i, v)} label={i === 0 ? 'Cover photo' : `Photo ${i + 1}`} />
            ))}
          </div>
          <div className="fld">
            <label>Title</label>
            <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={90} placeholder="e.g. PSA 10 Charizard Base Set" />
          </div>
          <div className="fld">
            <label>Description</label>
            <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={5} maxLength={2000}
              placeholder="Condition, provenance, what's included. Buyers bid harder when they know exactly what they're getting." />
          </div>
          <div className="fld-row">
            <div className="fld">
              <label>Category</label>
              <select value={category} onChange={(e) => setCategory(e.target.value)}>
                <option value="">No category</option>
                {CATEGORIES.map((c) => <option key={c.name} value={c.name}>{c.name}</option>)}
              </select>
            </div>
            <div className="fld">
              <label>Auction length</label>
              <select value={durationHours} onChange={(e) => setDurationHours(Number(e.target.value))}>
                {DURATIONS.map((d) => <option key={d.h} value={d.h}>{d.label}</option>)}
              </select>
            </div>
          </div>
          <div className="fld">
            <label>Starting bid (USDC)</label>
            <input inputMode="decimal" value={startingBid} onChange={(e) => setStartingBid(e.target.value)} placeholder="e.g. 25" />
          </div>
        </section>

        <section className="card acct-card">
          <h3 className="acct-sub">Shipping prices</h3>
          <p className="muted acct-note">
            What YOU charge to ship to each region; it shows on the listing as &ldquo;+$X shipping&rdquo; and is paid to the
            shipping pool automatically with the winning bid. Leave a region blank if you don&rsquo;t ship there.
          </p>
          {MARKET_REGIONS.map((r) => (
            <div key={r} className="mkt-sell__shiprow">
              <span>{REGION_LABEL[r]}</span>
              <div className="mkt-item__amt">
                <span>$</span>
                <input inputMode="decimal" value={ship[r] ?? ''} placeholder="—"
                  onChange={(e) => setShip((prev) => ({ ...prev, [r]: e.target.value }))} />
              </div>
            </div>
          ))}

          {err && <div className="auth__error" style={{ marginTop: 12 }}>{err}</div>}
          <div className="acct-actions">
            <button className="btn btn-primary" onClick={submit} disabled={busy}>
              {busy ? 'Listing…' : 'Start the auction'}
            </button>
          </div>
          <p className="muted" style={{ fontSize: 12.5 }}>
            The auction goes live the moment you list. You keep 95% of the winning bid; shipping covers the label.
          </p>
        </section>
      </div>
    </main>
  );
}
