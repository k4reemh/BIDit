import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  getLabelQueue,
  createLabel,
  getInflightShipments,
  adminMarkShipped,
  adminMarkDelivered,
  adminReleaseNow,
  type LabelQueueRow,
  type InflightShipment,
  type OriginAddr,
  type Session,
} from '../../api';

interface Addr { name?: string; line1?: string; line2?: string; city?: string; region?: string; postal?: string; country?: string }

const addrLines = (a: Addr | null | undefined): string[] => {
  if (!a) return [];
  return [a.name, a.line1, a.line2, [a.city, a.region, a.postal].filter(Boolean).join(', '), a.country].filter(Boolean) as string[];
};
const originLines = (o: OriginAddr | null | undefined): string[] => {
  if (!o) return [];
  return [[o.originCity, o.originRegion, o.originPostal].filter(Boolean).join(', '), o.originCountry].filter(Boolean) as string[];
};
const sizeOf = (d: LabelQueueRow['dims']) => (d.lengthCm ? `${d.lengthCm} × ${d.widthCm} × ${d.heightCm} cm · ${d.weightGrams} g` : '—');

export default function AdminShipments({ session }: { session: Session | null }) {
  const [queue, setQueue] = useState<LabelQueueRow[] | null>(null);
  const [inflight, setInflight] = useState<InflightShipment[]>([]);
  const [error, setError] = useState('');
  const load = () => {
    getLabelQueue().then(setQueue).catch((e) => setError(e instanceof Error ? e.message : 'Failed to load.'));
    getInflightShipments().then(setInflight).catch(() => {});
  };
  useEffect(() => { if (session?.isAdmin) void load(); }, [session?.isAdmin]);

  if (!session) return <Gate>Sign in with an admin account.</Gate>;
  if (!session.isAdmin) return <Gate>Your account isn’t an admin. Add your email to <code>BIDIT_ADMIN_EMAILS</code> on the backend.</Gate>;

  return (
    <main className="admin">
      <div className="acct-head">
        <div className="adm-nav">
          <Link to="/admin/sellers">Sellers</Link> <span>·</span>{' '}
          <Link to="/admin/orders">Orders</Link> <span>·</span>{' '}
          <Link to="/admin/shipments" className="active">Shipping</Link>
        </div>
        <h1 className="display acct-title">Shipping labels</h1>
        <p className="muted">Packages a seller has confirmed and that need a label. Buy the carrier label (seller&nbsp;→&nbsp;buyer, at the size shown), paste its link and tracking number, and hit “Label created” — the seller is emailed to print and ship it.</p>
      </div>
      {error && <div className="auth__error">{error}</div>}

      <h2 className="acct-sub" style={{ marginBottom: 12 }}>Needs a label</h2>
      {queue && queue.length === 0 && <p className="muted">Nothing waiting for a label right now. 🎉</p>}
      {(queue ?? []).map((row) => <QueueCard key={row.id} row={row} onDone={load} />)}

      {inflight.length > 0 && (
        <>
          <h2 className="acct-sub" style={{ margin: '30px 0 4px' }}>Test controls</h2>
          <p className="muted ship-sec__hint" style={{ marginBottom: 12 }}>Shippo advances these automatically in production — use these to drive a package through shipped → delivered → released by hand while testing.</p>
          {inflight.map((s) => <InflightRow key={s.id} s={s} onDone={load} setError={setError} />)}
        </>
      )}
    </main>
  );
}

function InflightRow({ s, onDone, setError }: { s: InflightShipment; onDone: () => void; setError: (m: string) => void }) {
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true); setError('');
    try { await fn(); onDone(); }
    catch (e) { setError(e instanceof Error ? e.message : 'Action failed.'); setBusy(false); }
  };
  const pill = s.status === 'LABEL_CREATED' ? { txt: 'Label ready', cls: 'is-ready' }
    : s.status === 'SHIPPED' ? { txt: 'In transit', cls: 'is-pending' }
    : { txt: 'Delivered', cls: 'is-ready' };
  return (
    <div className="card acct-card adm-lbl">
      <div className="adm-lbl__head" style={{ cursor: 'default' }}>
        <div className="adm-lbl__sum">
          <b>To @{s.buyerHandle}</b>
          <span className="muted"> · {s.items.map((i) => i.title).join(', ')} · from @{s.sellerHandle}</span>
        </div>
        <span className={`ship-pill ${pill.cls}`}>{pill.txt}</span>
      </div>
      <div className="adm-lbl__body" style={{ borderTop: '1px solid var(--line)', paddingTop: 12 }}>
        <div className="acct-actions">
          {s.status === 'LABEL_CREATED' && (
            <button className="btn btn-sm btn-primary" disabled={busy} onClick={() => run(() => adminMarkShipped(s.id))}>Mark shipped</button>
          )}
          {s.status === 'SHIPPED' && (
            <button className="btn btn-sm btn-primary" disabled={busy} onClick={() => run(() => adminMarkDelivered(s.id))}>Mark delivered</button>
          )}
          {s.releasable && (
            <button className="btn btn-sm btn-ghost" disabled={busy} onClick={() => run(() => adminReleaseNow(s.id))}>Release payment now</button>
          )}
          {s.status === 'DELIVERED' && !s.releasable && <span className="muted" style={{ alignSelf: 'center', fontSize: 12.5 }}>Released / resolved.</span>}
        </div>
      </div>
    </div>
  );
}

function QueueCard({ row, onDone }: { row: LabelQueueRow; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [labelUrl, setLabelUrl] = useState('');
  const [tracking, setTracking] = useState('');
  const [carrier, setCarrier] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const size = sizeOf(row.dims);

  const submit = async () => {
    if (!labelUrl.trim() || !tracking.trim()) { setErr('Paste the label link and the tracking number.'); return; }
    setBusy(true); setErr('');
    try { await createLabel(row.id, labelUrl.trim(), tracking.trim(), carrier.trim() || undefined); onDone(); }
    catch (e) { setErr(e instanceof Error ? e.message : 'Could not save the label.'); setBusy(false); }
  };

  return (
    <div className="card acct-card adm-lbl">
      <button className="adm-lbl__head" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <div className="adm-lbl__sum">
          <b>To @{row.buyer.handle}</b>
          <span className="muted"> · {row.items.length} item{row.items.length > 1 ? 's' : ''} · {size} · from @{row.seller.handle}</span>
        </div>
        <span className="adm-lbl__paid">${row.shippingPaid} paid</span>
        <span className={`adm-lbl__chev${open ? ' is-open' : ''}`} aria-hidden>▾</span>
      </button>

      {open && (
        <div className="adm-lbl__body">
          <div className="adm-lbl__grid">
            <div>
              <span className="adm-lbl__lbl">Items</span>
              <ul className="adm-lbl__items">{row.items.map((it) => <li key={it.id}>{it.title}</li>)}</ul>
            </div>
            <div>
              <span className="adm-lbl__lbl">Package size</span>
              <p>{size}</p>
              {row.mode === 'PRIVATE' && <p className="muted" style={{ fontSize: 12 }}>Private — the “ship to” below is the hub.</p>}
            </div>
            <div>
              <span className="adm-lbl__lbl">Ship from — {row.seller.name || `@${row.seller.handle}`}</span>
              {originLines(row.seller.origin).length ? originLines(row.seller.origin).map((l, i) => <p key={i}>{l}</p>) : <p className="muted">No origin on file.</p>}
            </div>
            <div>
              <span className="adm-lbl__lbl">Ship to — @{row.buyer.handle}</span>
              {addrLines(row.buyer.address as Addr).length ? addrLines(row.buyer.address as Addr).map((l, i) => <p key={i}>{l}</p>) : <p className="muted">No address on file.</p>}
            </div>
          </div>

          <div className="adm-lbl__form">
            <div className="fld">
              <label>Label file link</label>
              <input value={labelUrl} onChange={(e) => setLabelUrl(e.target.value)} placeholder="https://…/label.pdf" />
            </div>
            <div className="fld-row">
              <div className="fld"><label>Tracking number</label><input value={tracking} onChange={(e) => setTracking(e.target.value)} placeholder="1Z…" /></div>
              <div className="fld"><label>Carrier <span className="muted">— optional</span></label><input value={carrier} onChange={(e) => setCarrier(e.target.value)} placeholder="UPS, USPS…" /></div>
            </div>
            {err && <div className="auth__error">{err}</div>}
            <div className="acct-actions">
              <button className="btn btn-primary" disabled={busy} onClick={submit}>{busy ? 'Saving…' : 'Label created — notify seller'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Gate({ children }: { children: React.ReactNode }) {
  return (
    <main className="ce ce--gate">
      <h1 className="display" style={{ fontSize: 26, marginBottom: 8 }}>Admin</h1>
      <p className="muted">{children}</p>
    </main>
  );
}
