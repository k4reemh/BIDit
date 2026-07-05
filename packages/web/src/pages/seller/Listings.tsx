import { useEffect, useState } from 'react';
import { useSeller } from '../../components/SellerLayout';
import { openSocket } from '../../realtime';
import { getListings, startAuction, type SellerListing } from '../../api';
import AddItemModal from '../../components/seller/AddItemModal';
import AddWheelModal from '../../components/seller/AddWheelModal';
import EmptyState from '../../components/EmptyState';
import { Tag, Dice, Plus } from '../../icons';

function ListingCard({ l, onStarted }: { l: SellerListing; onStarted: () => void }) {
  const [dur, setDur] = useState('30');
  const [busy, setBusy] = useState(false);
  const isWheel = !!l.wheel;

  const start = async () => {
    setBusy(true);
    try {
      await startAuction(l.id, Number(dur) || 30);
      onStarted();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={`lc card${isWheel ? ' lc--wheel' : ''}`}>
      <div className="lc__thumb">
        {l.imageUrl ? <img src={l.imageUrl} alt="" /> : <span className="lc__ph">{isWheel ? <Dice width={26} height={26} /> : <Tag width={24} height={24} />}</span>}
        <span className={`lc__type${isWheel ? ' lc__type--wheel' : ''}`}>
          {isWheel ? <><Dice width={13} height={13} /> Randomizer</> : <><Tag width={13} height={13} /> Item</>}
        </span>
      </div>
      <div className="lc__body">
        <div className="lc__title">{l.title}</div>
        <div className="lc__meta">
          <span className={`pill lc__status lc__status--${l.status.toLowerCase()}`}>{l.status}</span>
          {!isWheel && l.quantity > 1 && <span className="pill lc__qty">×{l.quantity} left</span>}
          {isWheel && <span className="pill lc__wheelpill">{l.wheel!.length} prizes</span>}
          <span className="lc__start">Start ${l.startingBid}</span>
        </div>
        {l.status === 'QUEUED' && l.quantity > 0 && (
          <div className="lc__go">
            <div className="lc__dur"><input type="number" min="5" value={dur} onChange={(e) => setDur(e.target.value)} /><span>sec</span></div>
            <button className="btn btn-primary btn-sm" onClick={start} disabled={busy}>{busy ? 'Starting…' : l.quantity > 1 ? `Auction 1 of ${l.quantity}` : 'Start auction'}</button>
          </div>
        )}
        {l.status === 'SOLD' && <div className="lc__go"><span className="muted" style={{ fontSize: 13 }}>Sold out</span></div>}
        {l.status === 'LIVE' && <div className="lc__go"><span className="live-badge"><span className="dot" /> LIVE</span><span className="muted" style={{ fontSize: 13 }}>Auction running</span></div>}
      </div>
    </div>
  );
}

export default function Listings() {
  const { session } = useSeller();
  const [listings, setListings] = useState<SellerListing[] | null>(null);
  const [modal, setModal] = useState<'item' | 'wheel' | null>(null);

  const load = () => getListings().then(setListings).catch(() => setListings([]));
  useEffect(() => { load(); }, []);
  const onCreated = () => { setModal(null); load(); };

  // Live-refresh statuses: when an auction ends the listing flips off LIVE
  // (to QUEUED/SOLD) server-side — reload so the seller can immediately start the
  // next one without a manual page refresh.
  useEffect(() => {
    const stop = openSocket({
      room: session.userId,
      onClosed: () => getListings().then(setListings).catch(() => {}),
      onState: (m) => { if (m.status !== 'RUNNING') getListings().then(setListings).catch(() => {}); },
    });
    return stop;
  }, [session.userId]);

  return (
    <>
      <div className="acct-head sl-head">
        <div>
          <h1 className="display acct-title">Listings</h1>
          <p className="muted">Add items or randomizer wheels, then start an auction when you go live.</p>
        </div>
        <div className="sl-head__actions">
          <button className="btn btn-ghost" onClick={() => setModal('wheel')}><Dice width={17} height={17} /> Add randomizer</button>
          <button className="btn btn-primary" onClick={() => setModal('item')}><Plus width={17} height={17} /> Add item</button>
        </div>
      </div>

      {listings === null ? (
        <div className="muted" style={{ padding: 20 }}>Loading…</div>
      ) : listings.length === 0 ? (
        <EmptyState icon={Tag} title="No listings yet" sub="Add a single item, or build a randomizer wheel with multiple prizes. Both auction live to bidders." />
      ) : (
        <div className="listing-grid">
          {listings.map((l) => <ListingCard key={l.id} l={l} onStarted={load} />)}
        </div>
      )}

      {modal === 'item' && <AddItemModal onClose={() => setModal(null)} onCreated={onCreated} />}
      {modal === 'wheel' && <AddWheelModal onClose={() => setModal(null)} onCreated={onCreated} />}
    </>
  );
}
