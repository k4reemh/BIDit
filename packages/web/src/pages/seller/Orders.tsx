import { useEffect, useState } from 'react';
import { useSeller } from '../../components/SellerLayout';
import { getSellerOrders, shipOrder, deliverOrder, type SellerOrder } from '../../api';
import EmptyState from '../../components/EmptyState';
import { Truck, Tag } from '../../icons';

function OrderRow({ o, onChange }: { o: SellerOrder; onChange: () => void }) {
  const [tracking, setTracking] = useState('');
  const [busy, setBusy] = useState(false);
  const act = async (fn: () => Promise<unknown>) => { setBusy(true); try { await fn(); onChange(); } finally { setBusy(false); } };

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
      <div className="ord__act">
        {o.status === 'LOCKED' && (
          <>
            <input className="ord__track" placeholder="Tracking #" value={tracking} onChange={(e) => setTracking(e.target.value)} />
            <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => act(() => shipOrder(o.id, tracking.trim() || undefined))}>Mark shipped</button>
          </>
        )}
        {o.status === 'SHIPPED' && (
          <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => act(() => deliverOrder(o.id))}>Mark delivered</button>
        )}
        {!['LOCKED', 'SHIPPED'].includes(o.status) && <span className="muted" style={{ fontSize: 13 }}>—</span>}
      </div>
    </div>
  );
}

export default function Orders() {
  useSeller();
  const [orders, setOrders] = useState<SellerOrder[] | null>(null);
  const load = () => getSellerOrders().then(setOrders).catch(() => setOrders([]));
  useEffect(() => { load(); }, []);

  return (
    <>
      <div className="acct-head">
        <h1 className="display acct-title">Orders</h1>
        <p className="muted">Ship what buyers win — funds release from escrow after delivery.</p>
      </div>
      {orders === null ? (
        <div className="muted" style={{ padding: 20 }}>Loading…</div>
      ) : orders.length === 0 ? (
        <EmptyState icon={Truck} title="No orders yet" sub="When a buyer wins one of your auctions it shows up here, ready to ship." />
      ) : (
        <div className="ord-list">{orders.map((o) => <OrderRow key={o.id} o={o} onChange={load} />)}</div>
      )}
    </>
  );
}
