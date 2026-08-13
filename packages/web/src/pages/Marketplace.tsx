import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { getMarket, money2, fromMicros, type MarketCard, type MarketSort } from '../api';
import { mediaSrc } from '../config';
import Avatar from '../components/Avatar';
import { Verified, Tag } from '../icons';
import { CATEGORIES } from '../data';

/** Compact "2d 4h" / "3h 12m" / "48m" / "ending" time-left label. */
export function timeLeft(endsAt: number, now = Date.now()): { label: string; urgent: boolean } {
  const ms = endsAt - now;
  if (ms <= 0) return { label: 'ended', urgent: true };
  const m = Math.floor(ms / 60000);
  if (m < 1) return { label: 'ending', urgent: true };
  if (m < 60) return { label: `${m}m`, urgent: m <= 30 };
  const h = Math.floor(m / 60);
  if (h < 24) return { label: `${h}h ${m % 60}m`, urgent: false };
  const d = Math.floor(h / 24);
  return { label: `${d}d ${h % 24}h`, urgent: false };
}

const SORTS: { key: MarketSort; label: string }[] = [
  { key: 'ending', label: 'Ending soon' },
  { key: 'newest', label: 'Newly listed' },
  { key: 'price_asc', label: 'Price: low to high' },
  { key: 'price_desc', label: 'Price: high to low' },
];

function ShipTag({ c }: { c: MarketCard }) {
  // NFTs deliver digitally: no shipping line, an NFT badge instead.
  if (c.nft) return <span className="mkt-card__nft">NFT{c.nftCount > 1 ? ` ×${c.nftCount}` : ''}</span>;
  // Show the cheapest lane the seller offers; the item page shows the viewer's own.
  const prices = Object.values(c.shipPrices).map((p) => Number(p) / 1e6);
  if (prices.length === 0) return null;
  const min = Math.min(...prices);
  return <span className="mkt-card__ship">{min === 0 ? 'free shipping' : `+$${money2(min)} shipping`}</span>;
}

export default function Marketplace() {
  const [cards, setCards] = useState<MarketCard[] | null>(null);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [category, setCategory] = useState('');
  const [sort, setSort] = useState<MarketSort>('ending');
  const [now, setNow] = useState(Date.now());
  const navigate = useNavigate();

  useEffect(() => {
    let alive = true;
    getMarket({ category: category || undefined, sort, page })
      .then((r) => {
        if (!alive) return;
        setCards((prev) => (page > 0 && prev ? [...prev, ...r.items] : r.items));
        setTotal(r.total);
      })
      .catch(() => alive && setCards((prev) => prev ?? []));
    return () => { alive = false; };
  }, [category, sort, page]);

  // Tick the countdowns once a minute; the grid doesn't need per-second churn.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);

  const shown = useMemo(() => (cards ?? []).filter((c) => c.endsAt > now), [cards, now]);

  return (
    <main className="container mkt">
      <header className="mkt__head">
        <div>
          <h1 className="display mkt__title">The Marketplace</h1>
          <p className="muted">Timed auctions from real sellers. Bid, win, it ships to your door.</p>
        </div>
        <button className="btn btn-primary" onClick={() => navigate('/marketplace/sell')}>
          <Tag width={16} height={16} style={{ marginRight: 6, verticalAlign: '-2px' }} />
          Sell an item
        </button>
      </header>

      <div className="mkt__filters">
        <div className="mkt__cats">
          <button className={`mkt-chip${category === '' ? ' is-on' : ''}`} onClick={() => { setCategory(''); setPage(0); }}>All</button>
          {CATEGORIES.map((c) => (
            <button
              key={c.name}
              className={`mkt-chip${category === c.name ? ' is-on' : ''}`}
              onClick={() => { setCategory(category === c.name ? '' : c.name); setPage(0); }}
            >
              {c.name}
            </button>
          ))}
        </div>
        <select className="mkt__sort" value={sort} onChange={(e) => { setSort(e.target.value as MarketSort); setPage(0); }}>
          {SORTS.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
        </select>
      </div>

      {cards === null ? (
        <p className="muted" style={{ padding: '40px 0' }}>Loading the marketplace…</p>
      ) : shown.length === 0 ? (
        <div className="mkt__empty">
          <b>No auctions here yet</b>
          <p className="muted">
            {category ? 'Nothing live in this category right now. Try another one, or ' : 'Be the first: '}
            <Link to="/marketplace/sell">list an item</Link> and start the bidding.
          </p>
        </div>
      ) : (
        <>
          <div className="mkt__grid">
            {shown.map((c) => {
              const t = timeLeft(c.endsAt, now);
              const price = fromMicros(c.currentBid) ?? fromMicros(c.startingBid)!;
              return (
                <Link key={c.auctionId} className="mkt-card" to={`/marketplace/${c.auctionId}`}>
                  <div className="mkt-card__ph">
                    {c.photo ? <img src={mediaSrc(c.photo) ?? undefined} alt="" loading="lazy" /> : <div className="mkt-card__noimg" />}
                    <span className={`mkt-card__time${t.urgent ? ' is-urgent' : ''}`}>{t.label}</span>
                    {c.bidCount > 0 && <span className="mkt-card__bids">{c.bidCount} bid{c.bidCount === 1 ? '' : 's'}</span>}
                  </div>
                  <div className="mkt-card__body">
                    <div className="mkt-card__name">{c.title}</div>
                    <div className="mkt-card__priceline">
                      <b>${money2(price)}</b>
                      <ShipTag c={c} />
                    </div>
                    <div className="mkt-card__seller">
                      <Avatar handle={c.sellerHandle} src={c.sellerAvatar} size={16} />
                      <span>@{c.sellerHandle}</span>
                      {c.sellerVerified && <Verified width={12} height={12} />}
                    </div>
                  </div>
                </Link>
              );
            })}
          </div>
          {shown.length < total && (
            <div className="mkt__more">
              <button className="btn btn-ghost" onClick={() => setPage((p) => p + 1)}>Show more</button>
            </div>
          )}
        </>
      )}
    </main>
  );
}
