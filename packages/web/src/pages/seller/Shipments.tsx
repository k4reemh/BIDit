import { useEffect, useState } from 'react';
import { useSeller } from '../../components/SellerLayout';
import EmptyState from '../../components/EmptyState';
import { getSellerShipments, shipShipment, type Shipment } from '../../api';
import { Truck, Check } from '../../icons';

interface Addr { name?: string; line1?: string; line2?: string; city?: string; region?: string; postal?: string; country?: string }

export default function Shipments() {
  useSeller();
  const [shipments, setShipments] = useState<Shipment[] | null>(null);
  const [error, setError] = useState('');
  const load = () => getSellerShipments().then(setShipments).catch((e) => setError(e instanceof Error ? e.message : 'Failed to load.'));
  useEffect(() => { void load(); }, []);

  const toShip = (shipments ?? []).filter((s) => s.status === 'PAID');
  const shipped = (shipments ?? []).filter((s) => s.status === 'SHIPPED');

  return (
    <>
      <div className="acct-head">
        <h1 className="display acct-title">Shipments</h1>
        <p className="muted">Packages buyers have paid to ship. Pack them, add tracking, and mark them shipped.</p>
      </div>
      {error && <div className="auth__error">{error}</div>}

      {shipments && toShip.length === 0 && shipped.length === 0 && (
        <EmptyState icon={Truck} title="No shipments yet" sub="When a buyer pays shipping on a card they won from you, it shows up here to fulfill." />
      )}

      {toShip.map((s) => <FulfillCard key={s.id} shipment={s} onShipped={load} />)}

      {shipped.length > 0 && <h2 className="acct-sub" style={{ fontSize: 18, marginTop: 24 }}>Shipped</h2>}
      {shipped.map((s) => (
        <div key={s.id} className="card acct-card">
          <div className="ship-grp__head">
            <h3 className="acct-sub" style={{ margin: 0 }}>To @{s.buyerHandle} · {s.items.length} item{s.items.length > 1 ? 's' : ''}</h3>
            <span className="acct-saved"><Check width={14} height={14} /> Shipped</span>
          </div>
          {s.trackingNumber && <p className="muted acct-note">Tracking: <b>{s.carrier ? `${s.carrier} · ` : ''}{s.trackingNumber}</b></p>}
        </div>
      ))}
    </>
  );
}

function FulfillCard({ shipment, onShipped }: { shipment: Shipment; onShipped: () => void }) {
  const [tracking, setTracking] = useState('');
  const [carrier, setCarrier] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const a = (shipment.shipTo ?? {}) as Addr;
  const isPrivate = shipment.mode === 'PRIVATE';

  const ship = async () => {
    setBusy(true); setErr('');
    try { await shipShipment(shipment.id, tracking.trim() || undefined, carrier.trim() || undefined); onShipped(); }
    catch (e) { setErr(e instanceof Error ? e.message : 'Could not mark shipped.'); setBusy(false); }
  };

  return (
    <div className="card acct-card">
      <div className="ship-grp__head">
        <h3 className="acct-sub" style={{ margin: 0 }}>To @{shipment.buyerHandle} · {shipment.items.length} item{shipment.items.length > 1 ? 's' : ''}</h3>
        <span className="muted" style={{ fontSize: 12 }}>You earn ${shipment.shippingFee} shipping</span>
      </div>

      <div className="ship-list">
        {shipment.items.map((it) => (
          <div key={it.id} className="ship-row">
            {it.image ? <img className="ship-thumb" src={it.image} alt="" /> : <div className="ship-thumb ship-thumb--ph" />}
            <div className="ship-meta"><b>{it.title}</b></div>
          </div>
        ))}
      </div>

      <div className="ship-addr">
        <span className="muted" style={{ fontSize: 12 }}>{isPrivate ? 'Ship to BIDit (private — we forward to the buyer):' : 'Ship to:'}</span>
        <div className="ship-addr__body">
          <b>{a.name}</b>
          <span>{a.line1}{a.line2 ? `, ${a.line2}` : ''}</span>
          <span>{[a.city, a.region, a.postal].filter(Boolean).join(', ')}</span>
          <span>{a.country}</span>
        </div>
      </div>

      {err && <div className="auth__error">{err}</div>}
      <div className="fld-row">
        <div className="fld"><label>Carrier <span className="muted">— optional</span></label><input value={carrier} onChange={(e) => setCarrier(e.target.value)} placeholder="USPS, UPS…" /></div>
        <div className="fld"><label>Tracking number <span className="muted">— optional</span></label><input value={tracking} onChange={(e) => setTracking(e.target.value)} placeholder="Tracking #" /></div>
      </div>
      <div className="acct-actions">
        <button className="btn btn-primary" disabled={busy} onClick={ship}>{busy ? 'Saving…' : 'Mark shipped'}</button>
      </div>
    </div>
  );
}
