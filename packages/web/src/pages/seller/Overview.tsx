import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useSeller } from '../../components/SellerLayout';
import { getListings, getSellerOrders, type SellerListing, type SellerOrder } from '../../api';
import { Tag, Dice, Truck, ArrowRight } from '../../icons';

const sum = (xs: string[]) => xs.reduce((a, b) => a + (parseFloat(b) || 0), 0);
const money = (n: number) => `$${n.toFixed(2)}`;

export default function Overview() {
  const { session } = useSeller();
  const [listings, setListings] = useState<SellerListing[]>([]);
  const [orders, setOrders] = useState<SellerOrder[]>([]);

  useEffect(() => {
    getListings().then(setListings).catch(() => {});
    getSellerOrders().then(setOrders).catch(() => {});
  }, []);

  const gmv = sum(orders.map((o) => o.amount));
  const bid = sum(orders.map((o) => o.platformFee));
  const live = listings.filter((l) => l.status === 'LIVE').length;
  const queued = listings.filter((l) => l.status === 'QUEUED').length;

  const stats = [
    { label: 'Gross sales', value: money(gmv), sub: `${orders.length} orders` },
    { label: 'Available balance', value: `$${session.available}`, sub: 'USDC' },
    { label: 'Live now', value: String(live), sub: `${queued} queued` },
    { label: '→ $BID buyback', value: money(bid), sub: '4% of sales' },
  ];

  const actions = [
    { icon: Tag, title: 'Add an item', sub: 'Single card, bid to win.', to: '/seller/listings' },
    { icon: Dice, title: 'Add a randomizer', sub: 'Bid for a spin, wheel picks the prize.', to: '/seller/listings' },
    { icon: Truck, title: 'Fulfill orders', sub: 'Ship what buyers have won.', to: '/seller/orders' },
  ];

  return (
    <>
      <div className="acct-head">
        <h1 className="display acct-title">Welcome back, {session.displayName || session.handle}</h1>
        <p className="muted">Here’s your shop at a glance.</p>
      </div>

      <div className="stat-grid">
        {stats.map((s) => (
          <div className="stat card" key={s.label}>
            <span className="stat__label">{s.label}</span>
            <b className="stat__value">{s.value}</b>
            <span className="stat__sub muted">{s.sub}</span>
          </div>
        ))}
      </div>

      <h2 className="sl-sec">Quick start</h2>
      <div className="qa-grid">
        {actions.map((a) => (
          <Link className="qa card" to={a.to} key={a.title}>
            <span className="qa__ic"><a.icon width={20} height={20} /></span>
            <div className="qa__txt"><b>{a.title}</b><span className="muted">{a.sub}</span></div>
            <ArrowRight className="qa__arrow" width={17} height={17} />
          </Link>
        ))}
      </div>

      <h2 className="sl-sec">Recent listings</h2>
      {listings.length === 0 ? (
        <div className="sl-empty card">No listings yet — <Link to="/seller/listings" className="accent">add your first</Link>.</div>
      ) : (
        <div className="rl">
          {listings.slice(0, 5).map((l) => (
            <div className="rl__row" key={l.id}>
              <span className="rl__ic">{l.wheel ? <Dice width={16} height={16} /> : <Tag width={16} height={16} />}</span>
              <span className="rl__title">{l.title}</span>
              {l.wheel && <span className="pill lc__wheelpill">{l.wheel.length} prizes</span>}
              <span className={`pill lc__status lc__status--${l.status.toLowerCase()}`}>{l.status}</span>
              <span className="rl__bid muted">${l.startingBid}</span>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
