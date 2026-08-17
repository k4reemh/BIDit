import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useSeller } from '../../components/SellerLayout';
import { openSocket } from '../../realtime';
import {
  getListings,
  startAuction,
  setStorePrice,
  getMyNfts,
  listNftForAuction,
  type SellerListing,
  type NftAsset,
} from '../../api';
import AddItemModal from '../../components/seller/AddItemModal';
import AddWheelModal from '../../components/seller/AddWheelModal';
import EmptyState from '../../components/EmptyState';
import { Tag, Dice, Plus, Bag, Grid } from '../../icons';

/** A deposited, unlisted custody NFT: queue it for the stream right from here.
 *  The runtime is picked on the listing card's start control after queueing. */
function WalletNftCard({ a, onQueued }: { a: NftAsset; onQueued: () => void }) {
  const [bid, setBid] = useState('1');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const queue = async () => {
    setErr('');
    setBusy(true);
    try {
      await listNftForAuction({ assetIds: [a.id], startingBid: bid.trim() || '1', mode: 'stream' });
      onQueued();
    } catch (e) {
      setErr((e as Error).message || 'Could not queue this NFT.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="lc card lc--nft">
      <div className="lc__thumb">
        {a.image ? <img src={a.image} alt="" /> : <span className="lc__ph"><Grid width={24} height={24} /></span>}
        <span className="lc__type lc__type--nft"><Grid width={13} height={13} /> NFT</span>
      </div>
      <div className="lc__body">
        <div className="lc__title">{a.name ?? `NFT ${a.mint.slice(0, 6)}`}</div>
        <div className="lc__meta">
          {a.collection && <span className="pill lc__qty">{a.collection}</span>}
          <span className="pill lc__status lc__status--queued">In wallet</span>
        </div>
        <div className="lc__go">
          <div className="lc__dur">
            <span>$</span>
            <input type="number" min="1" step="1" value={bid} onChange={(e) => setBid(e.target.value)} />
          </div>
          <button className="btn btn-primary btn-sm" onClick={queue} disabled={busy}>
            {busy ? 'Queueing…' : 'Queue for stream'}
          </button>
        </div>
        {err && <div className="auth__error" style={{ marginTop: 8, fontSize: 12.5 }}>{err}</div>}
      </div>
    </div>
  );
}

function ListingCard({ l, onStarted, onEdit }: { l: SellerListing; onStarted: () => void; onEdit: (l: SellerListing) => void }) {
  const [dur, setDur] = useState('30');
  const [busy, setBusy] = useState(false);
  const [priceOpen, setPriceOpen] = useState(false);
  const [price, setPrice] = useState(l.buyNowPrice ?? '');
  const [priceBusy, setPriceBusy] = useState(false);
  const isWheel = !!l.wheel;
  const isNft = l.nft === true;

  const start = async () => {
    setBusy(true);
    try {
      await startAuction(l.id, Number(dur) || 30);
      onStarted();
    } finally {
      setBusy(false);
    }
  };

  const savePrice = async (next: string | null) => {
    setPriceBusy(true);
    try {
      await setStorePrice(l.id, next);
      setPriceOpen(false);
      onStarted(); // reload listings
    } finally {
      setPriceBusy(false);
    }
  };

  return (
    <div className={`lc card${isWheel ? ' lc--wheel' : ''}${isNft ? ' lc--nft' : ''}`}>
      <div className="lc__thumb">
        {l.imageUrl ? <img src={l.imageUrl} alt="" /> : <span className="lc__ph">{isWheel ? <Dice width={26} height={26} /> : isNft ? <Grid width={24} height={24} /> : <Tag width={24} height={24} />}</span>}
        <span className={`lc__type${isWheel ? ' lc__type--wheel' : ''}${isNft ? ' lc__type--nft' : ''}`}>
          {isWheel ? <><Dice width={13} height={13} /> Randomizer</> : isNft ? <><Grid width={13} height={13} /> NFT</> : <><Tag width={13} height={13} /> Item</>}
        </span>
      </div>
      <div className="lc__body">
        <div className="lc__title">{l.title}</div>
        <div className="lc__meta">
          <span className={`pill lc__status lc__status--${l.status.toLowerCase()}`}>{l.status}</span>
          {!isWheel && l.quantity > 1 && <span className="pill lc__qty">×{l.quantity} left</span>}
          {isWheel && <span className="pill lc__wheelpill">{l.wheel!.length} prizes</span>}
          {!isWheel && l.buyNowPrice && <span className="pill lc__store"><Bag width={12} height={12} /> ${l.buyNowPrice}</span>}
          <span className="lc__start">Start ${l.startingBid}</span>
        </div>
        {!isNft && l.status !== 'LIVE' && l.status !== 'SOLD' && (
          <button className="lc__storelink" onClick={() => onEdit(l)}>
            <Tag width={13} height={13} /> Edit listing
          </button>
        )}
        {/* Store (buy now) price: physical items only, until sold out. NFTs
            deliver by instant credit and sell via stream or the marketplace. */}
        {!isWheel && !isNft && l.status !== 'SOLD' && (
          priceOpen ? (
            <div className="lc__priceform">
              <input
                type="number" min="0.01" step="0.01" value={price} autoFocus
                onChange={(e) => setPrice(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && price.trim() && savePrice(price.trim())}
                placeholder="USDC"
              />
              <button className="btn btn-primary btn-sm" disabled={priceBusy || !price.trim()} onClick={() => savePrice(price.trim())}>Save</button>
              {l.buyNowPrice && <button className="btn btn-ghost btn-sm" disabled={priceBusy} onClick={() => savePrice(null)}>Remove</button>}
              <button className="btn btn-ghost btn-sm" disabled={priceBusy} onClick={() => setPriceOpen(false)}>Cancel</button>
            </div>
          ) : (
            <button className="lc__storelink" onClick={() => { setPrice(l.buyNowPrice ?? ''); setPriceOpen(true); }}>
              <Bag width={13} height={13} /> {l.buyNowPrice ? `In your shop at $${l.buyNowPrice} · edit` : 'Sell in your shop (buy now)'}
            </button>
          )
        )}
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
  const [nfts, setNfts] = useState<NftAsset[]>([]);
  const [modal, setModal] = useState<'item' | 'wheel' | null>(null);
  const [editing, setEditing] = useState<SellerListing | null>(null);

  const load = () => {
    getListings().then(setListings).catch(() => setListings([]));
    getMyNfts().then(setNfts).catch(() => {});
  };
  useEffect(() => { load(); }, []);
  const onCreated = () => { setModal(null); setEditing(null); load(); };

  // Deposited custody NFTs not yet on any listing: queueable straight from here.
  const walletNfts = nfts.filter((a) => a.status === 'HELD' && !a.locked);

  // Live-refresh statuses: when an auction ends the listing flips off LIVE
  // (to QUEUED/SOLD) server-side: reload so the seller can immediately start the
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

      {walletNfts.length > 0 && (
        <section style={{ marginBottom: 26 }}>
          <div className="section__head" style={{ marginBottom: 12 }}>
            <div>
              <h2 className="section-title" style={{ fontSize: 19 }}>NFTs in your wallet</h2>
              <div className="section-sub">
                Deposited and ready. Set a starting bid and queue one; you pick how many seconds it runs when you
                start it below. Manage deposits in <Link to="/nfts">My NFTs</Link>.
              </div>
            </div>
          </div>
          <div className="listing-grid">
            {walletNfts.map((a) => <WalletNftCard key={a.id} a={a} onQueued={load} />)}
          </div>
        </section>
      )}

      {listings === null ? (
        <div className="muted" style={{ padding: 20 }}>Loading…</div>
      ) : listings.length === 0 && walletNfts.length === 0 ? (
        <EmptyState icon={Tag} title="No listings yet" sub="Add a single item, or build a randomizer wheel with multiple prizes. Both auction live to bidders." />
      ) : (
        <div className="listing-grid">
          {listings.map((l) => <ListingCard key={l.id} l={l} onStarted={load} onEdit={setEditing} />)}
        </div>
      )}

      {modal === 'item' && <AddItemModal onClose={() => setModal(null)} onCreated={onCreated} />}
      {/* A wheel edit is a prize-pool edit, so it opens the wheel builder, not
          the single-item form. */}
      {editing && (editing.wheel
        ? <AddWheelModal existing={editing} onClose={() => setEditing(null)} onCreated={onCreated} />
        : <AddItemModal existing={editing} onClose={() => setEditing(null)} onCreated={onCreated} />)}
      {modal === 'wheel' && <AddWheelModal onClose={() => setModal(null)} onCreated={onCreated} />}
    </>
  );
}
