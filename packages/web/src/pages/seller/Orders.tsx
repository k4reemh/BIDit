import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useSeller } from '../../components/SellerLayout';
import { getSellerOrders, type SellerOrder } from '../../api';
import EmptyState from '../../components/EmptyState';
import { Truck, Tag } from '../../icons';

/** Read-only: the seller never marks an order shipped/delivered or enters a tracking
 *  number. They confirm the package size in Shipments; BIDit creates the label + the
 *  tracking number, and the carrier's scans drive shipped → delivered automatically. */
function OrderRow({ o }: { o: SellerOrder }) {
  return (
    <div className="ord card">
      <div className="ord__thumb">{o.image ? <img src={o.image} alt="" /> : <Tag width={20} height={20} />}</div>
      <div className="ord__main">
        <div className="ord__title">{o.title}</div>
        <div className="ord__sub muted">Won by <b>@{o.buyer}</b> · ${o.amount}</div>
      </div>
      <div className="ord__side">
        <span className={`pill ord__status ord__status--${o.status.toLowerCase()}`}>{o.status.replace(/_/g, ' ')}</span>
        <span className="ord__proceeds muted">You get ${o.sellerProceeds}</span>
      </div>
    </div>
  );
}

export default function Orders() {
  useSeller();
  const [orders, setOrders] = useState<SellerOrder[] | null>(null);
  useEffect(() => { getSellerOrders().then(setOrders).catch(() => setOrders([])); }, []);

  return (
    <>
      <div className="acct-head">
        <h1 className="display acct-title">Orders</h1>
        <p className="muted">Everything buyers have won from you. To send one, confirm its box size in <Link to="/seller/shipments">Shipments</Link> — we make the label and tracking updates on its own.</p>
      </div>
      {orders === null ? (
        <div className="muted" style={{ padding: 20 }}>Loading…</div>
      ) : orders.length === 0 ? (
        <EmptyState icon={Truck} title="No orders yet" sub="When a buyer wins one of your auctions it shows up here." />
      ) : (
        <div className="ord-list">{orders.map((o) => <OrderRow key={o.id} o={o} />)}</div>
      )}
    </>
  );
}
