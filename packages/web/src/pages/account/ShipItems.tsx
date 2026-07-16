import { useEffect, useState } from 'react';
import { useAccount } from '../../components/AccountLayout';
import EmptyState from '../../components/EmptyState';
import {
  getFulfillment,
  createShipment,
  estimateShipment,
  discardFulfillmentItem,
  confirmReceived,
  refreshMe,
  updateMe,
  type Fulfillment,
  type FulfillmentItem,
  type Shipment,
  type ShipEstimate,
} from '../../api';
import { Truck, Check } from '../../icons';
import DisputeModal from '../../components/DisputeModal';

const fmtDate = (ms: number) => new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

export default function ShipItems() {
  const { session, setSession } = useAccount();
  const [data, setData] = useState<Fulfillment | null>(null);
  const [error, setError] = useState('');

  const load = () => getFulfillment().then(setData).catch((e) => setError(e instanceof Error ? e.message : 'Failed to load.'));
  useEffect(() => { void load(); }, []);

  const toggleBundle = async () => {
    setSession(await updateMe({ bundleShipping: !session.bundleShipping }));
  };

  // Group ready-to-ship items by seller — a shipment can only hold one seller's items.
  const bySeller = new Map<string, FulfillmentItem[]>();
  for (const it of data?.items ?? []) {
    const arr = bySeller.get(it.sellerId) ?? [];
    arr.push(it);
    bySeller.set(it.sellerId, arr);
  }
  const shipments = data?.shipments ?? [];

  const afterChange = async () => {
    await load();
    try { setSession(await refreshMe()); } catch { /* balance also polls */ }
  };

  return (
    <>
      <div className="acct-head">
        <h1 className="display acct-title">Ready to ship</h1>
        <p className="muted">Cards you’ve won and are being held for you. Ship them whenever you like — bundle a seller’s items to pay shipping once.</p>
      </div>

      <label className="ship-priv card acct-card" style={{ alignItems: 'center', padding: '12px 14px' }}>
        <input type="checkbox" checked={session.bundleShipping ?? false} onChange={toggleBundle} />
        <span><b>Weekly bundling</b> — where a seller offers it, pay shipping just once a week and get all that week’s wins in one package.</span>
      </label>

      {error && <div className="auth__error">{error}</div>}

      {data && bySeller.size === 0 && shipments.length === 0 && (
        <EmptyState
          icon={Truck}
          title="Nothing waiting to ship"
          sub="Win an auction and the card lands here, held for up to 14 days until you choose to ship it."
          ctaText="Find something to win"
          ctaTo="/"
        />
      )}

      {[...bySeller.entries()].map(([sellerId, items]) => (
        <SellerGroup key={sellerId} items={items} onChanged={afterChange} defaultPrivate={session.shippingMode === 'PRIVATE'} />
      ))}

      {shipments.length > 0 && (
        <div className="acct-head" style={{ marginTop: 26 }}>
          <h2 className="acct-sub" style={{ fontSize: 18 }}>On the way</h2>
        </div>
      )}
      {shipments.map((s) => (
        <ShipmentCard key={s.id} shipment={s} onChanged={afterChange} />
      ))}
    </>
  );
}

function SellerGroup({ items, onChanged, defaultPrivate = false }: { items: FulfillmentItem[]; onChanged: () => void; defaultPrivate?: boolean }) {
  const [sel, setSel] = useState<Set<string>>(new Set(items.map((i) => i.id)));
  const [priv, setPriv] = useState(defaultPrivate);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const [est, setEst] = useState<ShipEstimate | null>(null);

  const toggle = (id: string) =>
    setSel((prev) => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });

  // Live UPS estimate for the current selection — refreshes as items or the
  // privacy toggle change. Debounced so rapid clicks don't spam the backend.
  const selKey = [...sel].sort().join(',');
  useEffect(() => {
    const ids = selKey ? selKey.split(',') : [];
    if (ids.length === 0) { setEst(null); return; }
    let live = true;
    const t = setTimeout(() => {
      estimateShipment(ids, priv ? { private: true } : undefined)
        .then((e) => { if (live) setEst(e); })
        .catch(() => { if (live) setEst(null); });
    }, 180);
    return () => { live = false; clearTimeout(t); };
  }, [selKey, priv]);

  const ship = async () => {
    const ids = [...sel];
    if (ids.length === 0) return;
    setBusy(true); setErr(''); setMsg('');
    try {
      const shipment = await createShipment(ids, priv ? { mode: 'PRIVATE', private: true } : undefined);
      const total = priv ? `$${shipment.shippingFee} + $${shipment.privacyFee} privacy` : `$${shipment.shippingFee}`;
      setMsg(`Shipping paid (${total}). The seller has been notified to ship.`);
      onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not create shipment.');
    } finally {
      setBusy(false);
    }
  };

  const discard = async (id: string, title: string) => {
    if (!window.confirm(`Discard “${title}”? You paid for it, so this forfeits the card — no refund. The seller keeps it.`)) return;
    setBusy(true); setErr('');
    try { await discardFulfillmentItem(id); onChanged(); }
    catch (e) { setErr(e instanceof Error ? e.message : 'Could not discard.'); }
    finally { setBusy(false); }
  };

  const held = items[0]?.heldUntil;
  return (
    <div className="card acct-card">
      <div className="ship-grp__head">
        <h3 className="acct-sub" style={{ margin: 0 }}>{items.length} item{items.length > 1 ? 's' : ''} from one seller</h3>
        {held && <span className="muted" style={{ fontSize: 12 }}>Held until {fmtDate(held)}</span>}
      </div>
      {err && <div className="auth__error">{err}</div>}
      {msg && <div className="dep-ok"><Check width={15} height={15} /> {msg}</div>}

      <div className="ship-list">
        {items.map((it) => (
          <label key={it.id} className="ship-row">
            <input type="checkbox" checked={sel.has(it.id)} onChange={() => toggle(it.id)} />
            {it.image ? <img className="ship-thumb" src={it.image} alt="" /> : <div className="ship-thumb ship-thumb--ph" />}
            <div className="ship-meta">
              <b>{it.title}</b>
              <span className="muted">Paid ${it.amount}{it.weightGrams ? ` · ~${it.weightGrams}g` : ''}</span>
            </div>
            <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => discard(it.id, it.title)}>Discard</button>
          </label>
        ))}
      </div>

      <label className="ship-priv">
        <input type="checkbox" checked={priv} onChange={(e) => setPriv(e.target.checked)} />
        <span>Private secure shipping — the seller never sees your address (adds a small privacy fee)</span>
      </label>

      {est && sel.size > 0 && (
        est.hasAddress ? (
          <div className="ship-est">
            <div className="ship-est__row">
              <span className="muted">Shipping <em className="ship-est__note">UPS est. ${est.carrierRetail} · {est.discountPct}% of retail{sel.size > 1 ? ' · +3% per extra item' : ''}</em></span>
              <b>${est.shippingFee}</b>
            </div>
            {Number(est.privacyFee) > 0 && (
              <div className="ship-est__row"><span className="muted">Private shipping fee</span><b>${est.privacyFee}</b></div>
            )}
            <div className="ship-est__row ship-est__total"><span>You pay</span><b>${est.total}</b></div>
          </div>
        ) : (
          <div className="ship-est ship-est--warn">
            <span className="muted">Add a shipping address to see your UPS shipping estimate.</span>
          </div>
        )
      )}

      <div className="acct-actions">
        <button className="btn btn-primary" disabled={busy || sel.size === 0} onClick={ship}>
          {busy ? 'Processing…' : est && est.hasAddress ? `Ship ${sel.size} item${sel.size === 1 ? '' : 's'} · $${est.total}` : `Ship ${sel.size} item${sel.size === 1 ? '' : 's'}`}
        </button>
      </div>
    </div>
  );
}

function ShipmentCard({ shipment, onChanged }: { shipment: Shipment; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [dispute, setDispute] = useState(false);
  const confirm = async () => {
    setBusy(true);
    try { await confirmReceived(shipment.id); onChanged(); }
    finally { setBusy(false); }
  };
  const label = shipment.status === 'PAID' ? 'Awaiting seller shipment'
    : shipment.status === 'LABEL_PENDING' || shipment.status === 'LABEL_CREATED' ? 'Getting ready to ship'
    : shipment.status === 'SHIPPED' ? 'On the way'
    : shipment.status === 'DELIVERED' ? 'Delivered'
    : shipment.status === 'DISPUTED' ? 'Problem reported'
    : shipment.status;
  return (
    <div className="card acct-card">
      <div className="ship-grp__head">
        <h3 className="acct-sub" style={{ margin: 0 }}>{shipment.items.length} item{shipment.items.length > 1 ? 's' : ''} · {label}</h3>
        <span className="muted" style={{ fontSize: 12 }}>Shipping ${shipment.shippingFee}{Number(shipment.privacyFee) > 0 ? ` + $${shipment.privacyFee} privacy` : ''}</span>
      </div>
      <div className="ship-list">
        {shipment.items.map((it) => (
          <div key={it.id} className="ship-row">
            {it.image ? <img className="ship-thumb" src={it.image} alt="" /> : <div className="ship-thumb ship-thumb--ph" />}
            <div className="ship-meta"><b>{it.title}</b></div>
          </div>
        ))}
      </div>
      {shipment.trackingNumber && (
        <p className="muted acct-note">Tracking: <b>{shipment.carrier ? `${shipment.carrier} · ` : ''}{shipment.trackingNumber}</b></p>
      )}
      {shipment.status === 'SHIPPED' && (
        <div className="acct-actions">
          <button className="btn btn-primary" disabled={busy} onClick={confirm}>{busy ? 'Confirming…' : 'Confirm received'}</button>
        </div>
      )}
      {shipment.status === 'DELIVERED' && (
        <>
          <p className="muted acct-note">Delivered. If anything’s wrong, report a problem within 2 days — otherwise you’re all set.</p>
          <div className="acct-actions">
            <button className="btn btn-ghost" onClick={() => setDispute(true)}>Report a problem</button>
          </div>
        </>
      )}
      {shipment.status === 'DISPUTED' && (
        <p className="muted acct-note">Problem reported — our team is reviewing it and will be in touch.</p>
      )}
      {dispute && (
        <DisputeModal
          shipmentId={shipment.id}
          onClose={() => setDispute(false)}
          onResolved={() => { setDispute(false); onChanged(); }}
        />
      )}
    </div>
  );
}
