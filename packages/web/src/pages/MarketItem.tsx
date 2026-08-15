import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  getMarketItem,
  placeMarketBidApi,
  buyMarketItemApi,
  delistMarketApi,
  refreshMe,
  money2,
  fromMicros,
  type MarketItemDetail,
  type Session,
} from '../api';
import { mediaSrc } from '../config';
import Avatar from '../components/Avatar';
import { Verified, Truck } from '../icons';
import { timeLeft } from './Marketplace';

const POLL_MS = 5000;
const REGION_LABEL: Record<string, string> = {
  US: 'United States', CA: 'Canada', UK: 'United Kingdom', EU: 'Europe', ASIA: 'Asia', OTHER: 'Rest of world',
};

/** Minimum next bid from the auction's increment rules (mirrors the server). */
function minNext(it: MarketItemDetail): number {
  const current = fromMicros(it.currentBid);
  if (current === null) return fromMicros(it.startingBid)!;
  const bump = Math.max(Number(it.minIncrementFloor) / 1e6, (current * it.minIncrementBps) / 10_000);
  return current + bump;
}

export default function MarketItem({ session, onAuth }: { session: Session | null; onAuth: () => void }) {
  const { id = '' } = useParams();
  const [it, setIt] = useState<MarketItemDetail | null | undefined>(undefined);
  const [photo, setPhoto] = useState(0);
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [flash, setFlash] = useState('');
  const [confirming, setConfirming] = useState(false);
  // Set after a successful buy-now: true = it was an NFT (points to My NFTs).
  const [bought, setBought] = useState<boolean | null>(null);
  const [now, setNow] = useState(Date.now());
  // Offset server time so the countdown can't drift with the viewer's clock.
  const skew = useRef(0);

  const load = async () => {
    try {
      const d = await getMarketItem(id);
      skew.current = d.serverNow - Date.now();
      setIt(d);
    } catch {
      setIt((prev) => (prev === undefined ? null : prev));
    }
  };

  useEffect(() => {
    setIt(undefined);
    void load();
    const poll = setInterval(load, POLL_MS);
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => { clearInterval(poll); clearInterval(tick); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, session?.userId]);

  const serverNow = now + skew.current;
  const ended = it?.endsAt != null && it.endsAt <= serverNow;
  const t = it?.endsAt ? timeLeft(it.endsAt, serverNow) : null;
  const nextBid = useMemo(() => (it ? minNext(it) : 0), [it]);
  const shipping = it?.viewer?.shippingC != null ? fromMicros(it.viewer.shippingC) : null;

  const bid = async () => {
    if (!session) return onAuth();
    if (!it) return;
    setErr('');
    setFlash('');
    const val = amount.trim() || String(nextBid);
    setBusy(true);
    try {
      const r = await placeMarketBidApi(it.auctionId!, val);
      setFlash(`You're the highest bidder at $${money2(fromMicros(r.currentBid)!)}.`);
      setAmount('');
      await load();
      refreshMe().catch(() => {});
    } catch (e) {
      setErr((e as Error).message || 'That bid could not be placed.');
    } finally {
      setBusy(false);
    }
  };

  const buy = async () => {
    if (!session) return onAuth();
    if (!it) return;
    setErr('');
    setBusy(true);
    try {
      const r = await buyMarketItemApi(it.listingId);
      setBought(r.nft);
      setConfirming(false);
      await load();
      refreshMe().catch(() => {});
    } catch (e) {
      setErr((e as Error).message || 'The purchase did not go through.');
      setConfirming(false);
      await load();
    } finally {
      setBusy(false);
    }
  };

  const delist = async () => {
    if (!it) return;
    setErr('');
    setBusy(true);
    try {
      await delistMarketApi(it.listingId);
      await load();
    } catch (e) {
      setErr((e as Error).message || 'Could not take the listing down.');
    } finally {
      setBusy(false);
    }
  };

  if (it === undefined) return <main className="container mkt-item"><p className="muted" style={{ padding: '48px 0' }}>Loading…</p></main>;
  if (it === null) {
    return (
      <main className="container mkt-item">
        <div className="mkt__empty"><b>Listing not found</b><p className="muted">It may have ended. <Link to="/marketplace">Back to the marketplace</Link></p></div>
      </main>
    );
  }

  const fixed = it.saleMode === 'fixed';
  const isOwner = session !== null && session.userId === it.seller.id;
  const current = fromMicros(it.currentBid);
  const priceLabel = fixed ? 'Price' : current !== null ? 'Current bid' : 'Starting bid';
  const price = fixed ? fromMicros(it.buyNow)! : current ?? fromMicros(it.startingBid)!;
  const total = shipping !== null ? price + shipping : null;
  // NFT auctions have no shipping lane, so nothing about the viewer's address
  // may gate the bid button.
  const noShipBlock = !it.nft && it.viewer !== null && it.viewer.hasAddress && shipping === null;

  return (
    <main className="container mkt-item">
      <nav className="mkt-item__crumbs muted">
        <Link to="/marketplace">Marketplace</Link>
        {it.category && <> / <Link to="/marketplace">{it.category}</Link></>}
      </nav>

      <div className="mkt-item__grid">
        {/* Gallery */}
        <section className="mkt-item__gallery">
          <div className="mkt-item__main">
            {it.photos[photo] ? <img src={mediaSrc(it.photos[photo]) ?? undefined} alt={it.title} /> : <div className="mkt-card__noimg" />}
            {t && <span className={`mkt-card__time${t.urgent ? ' is-urgent' : ''}`}>{ended ? 'ended' : t.label}</span>}
          </div>
          {it.photos.length > 1 && (
            <div className="mkt-item__thumbs">
              {it.photos.map((p, i) => (
                <button key={i} className={`mkt-item__thumb${i === photo ? ' is-on' : ''}`} onClick={() => setPhoto(i)}>
                  <img src={mediaSrc(p) ?? undefined} alt="" />
                </button>
              ))}
            </div>
          )}
          {it.description && (
            <div className="mkt-item__desc">
              <h3>Description</h3>
              <p>{it.description}</p>
            </div>
          )}
        </section>

        {/* Buy rail */}
        <aside className="mkt-item__rail">
          <h1 className="mkt-item__name">{it.title}</h1>
          <Link className="mkt-item__seller" to={`/live/@${it.seller.handle}`}>
            <Avatar handle={it.seller.handle} src={it.seller.avatarUrl} size={26} />
            <span>@{it.seller.handle}</span>
            {it.seller.verified && <span className="vpill"><Verified width={11} height={11} /> Verified</span>}
          </Link>

          <div className="mkt-item__pricebox">
            <div className="mkt-item__pricerow">
              <div>
                <span className="muted">{priceLabel}</span>
                <b className="mkt-item__price">${money2(price)}</b>
              </div>
              {t && <span className={`mkt-item__clock${t.urgent ? ' is-urgent' : ''}`}>{ended ? 'Auction ended' : `${t.label} left`}</span>}
              {fixed && <span className="mkt-item__clock">{it.available ? 'Buy now' : it.status === 'SOLD' ? 'Sold' : 'Taken down'}</span>}
            </div>

            <div className="mkt-item__shipline">
              <Truck width={15} height={15} />
              {it.nft ? (
                <span>Digital delivery: credited to the winner&rsquo;s BIDit account instantly</span>
              ) : it.viewer === null ? (
                <span>Sign in to see shipping to you</span>
              ) : !it.viewer.hasAddress ? (
                <span>Add your address to see shipping (<Link to="/shipping">Payments &amp; Shipping</Link>)</span>
              ) : shipping === null ? (
                <span className="mkt-item__noship">Doesn&rsquo;t ship to your region ({REGION_LABEL[it.viewer.region]})</span>
              ) : (
                <span>{shipping === 0 ? 'Free shipping' : `+$${money2(shipping)} shipping`} to {REGION_LABEL[it.viewer.region]}</span>
              )}
            </div>

            {fixed ? (
              <div className="mkt-item__buy">
                {bought !== null ? (
                  <div className="mkt-item__flash">
                    It&rsquo;s yours.{' '}
                    {bought ? <>The NFT is in <Link to="/nfts">My NFTs</Link>.</> : <>Track it in <Link to="/purchases">Purchases</Link>.</>}
                  </div>
                ) : !it.available ? (
                  <p className="muted" style={{ marginTop: 10 }}>
                    {it.status === 'SOLD' ? 'This item has sold.' : 'This listing was taken down.'}
                  </p>
                ) : isOwner ? (
                  <button className="btn btn-ghost" style={{ width: '100%' }} onClick={delist} disabled={busy}>
                    {busy ? 'Working…' : 'Take listing down'}
                  </button>
                ) : !confirming ? (
                  <button
                    className="btn btn-primary mkt-item__bidbtn"
                    style={{ width: '100%' }}
                    onClick={() => { if (!session) return onAuth(); setErr(''); setConfirming(true); }}
                    disabled={busy || noShipBlock}
                  >
                    Buy now for ${money2(price)}
                  </button>
                ) : (
                  <>
                    <button className="btn btn-primary mkt-item__bidbtn" style={{ width: '100%' }} onClick={buy} disabled={busy}>
                      {busy ? 'Buying…' : `Confirm: pay $${money2(total ?? price)}${!it.nft && shipping ? ' with shipping' : ''}`}
                    </button>
                    <button className="btn btn-ghost" style={{ width: '100%', marginTop: 8 }} onClick={() => setConfirming(false)} disabled={busy}>
                      Cancel
                    </button>
                  </>
                )}
                {err && <div className="auth__error">{err}</div>}
              </div>
            ) : !ended ? (
              <>
                <div className="mkt-item__bidrow">
                  <div className="mkt-item__amt">
                    <span>$</span>
                    <input
                      inputMode="decimal"
                      placeholder={money2(nextBid)}
                      value={amount}
                      onChange={(e) => setAmount(e.target.value)}
                      disabled={busy || noShipBlock}
                    />
                  </div>
                  <button
                    className="btn btn-primary mkt-item__bidbtn"
                    onClick={bid}
                    disabled={busy || it.viewer?.leading || noShipBlock}
                  >
                    {it.viewer?.leading ? 'Highest bidder' : busy ? 'Bidding…' : 'Place bid'}
                  </button>
                </div>
                <p className="muted mkt-item__minnote">
                  Minimum bid ${money2(nextBid)}.{' '}
                  {!it.nft && total !== null && <>Win now and you&rsquo;d pay <b>${money2((Number(amount) || nextBid) + shipping!)}</b> with shipping.</>}
                </p>
                {flash && <div className="mkt-item__flash">{flash}</div>}
                {err && <div className="auth__error">{err}</div>}
              </>
            ) : (
              <p className="muted" style={{ marginTop: 10 }}>This auction has ended.</p>
            )}
          </div>

          {it.nft ? (
            /* What the winner gets: every NFT in the batch, delivered instantly. */
            <div className="mkt-item__shiptable">
              <h3>{it.nftAssets.length > 1 ? `This batch: ${it.nftAssets.length} NFTs` : 'This NFT'}</h3>
              {it.nftAssets.map((n, i) => (
                <div key={i} className="mkt-item__shiprow mkt-item__nftrow">
                  <span className="mkt-item__nftname">
                    {n.image && <img src={n.image} alt="" />}
                    {n.name ?? 'Unnamed NFT'}
                  </span>
                  {n.collection && <b className="muted">{n.collection}</b>}
                </div>
              ))}
              <p className="muted">
                {fixed
                  ? `Buy and ${it.nftAssets.length > 1 ? 'all of them are' : 'it is'} credited to your BIDit account instantly.`
                  : `Win and ${it.nftAssets.length > 1 ? 'all of them are' : 'it is'} credited to your BIDit account the second the auction ends.`}{' '}
                Withdraw to any Solana wallet anytime; the seller is paid instantly.
              </p>
            </div>
          ) : (
            /* Shipping table: every region the seller offers */
            <div className="mkt-item__shiptable">
              <h3>Shipping</h3>
              {Object.entries(it.shipPrices).map(([region, micros]) => (
                <div key={region} className="mkt-item__shiprow">
                  <span>{REGION_LABEL[region] ?? region}</span>
                  <b>{Number(micros) === 0 ? 'Free' : `$${money2(Number(micros) / 1e6)}`}</b>
                </div>
              ))}
              <p className="muted">
                {fixed
                  ? 'Shipping is charged together with your purchase; the seller gets a paid label immediately.'
                  : 'Shipping is charged automatically with the winning bid. Funds for both are reserved when you bid.'}
              </p>
            </div>
          )}

          {/* Bid history (auctions only) */}
          {!fixed && (
            <div className="mkt-item__bids">
              <h3>Bid history</h3>
              {it.bids.length === 0 ? (
                <p className="muted">No bids yet. Start it off.</p>
              ) : (
                <ul>
                  {it.bids.map((b, i) => (
                    <li key={i}>
                      <span>@{b.handle}</span>
                      <b>${money2(fromMicros(b.amount)!)}</b>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </aside>
      </div>
    </main>
  );
}
