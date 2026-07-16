import { useEffect, useState } from 'react';
import { useSeller } from '../../components/SellerLayout';
import EmptyState from '../../components/EmptyState';
import {
  getSellerShipments,
  getSellerHeld,
  confirmShipmentLabel,
  shipShipment,
  type Shipment,
  type HeldItem,
} from '../../api';
import { Truck, Check } from '../../icons';

const fmtDate = (ms: number) => new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

function DownloadIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 3v12" /><path d="m7 10 5 5 5-5" /><path d="M5 21h14" />
    </svg>
  );
}

function Thumb({ src }: { src: string | null }) {
  return src ? <img className="ship-thumb" src={src} alt="" onError={(e) => (e.currentTarget.style.visibility = 'hidden')} /> : <div className="ship-thumb ship-thumb--ph" />;
}

function Items({ shipment }: { shipment: Shipment }) {
  return (
    <div className="ship-list">
      {shipment.items.map((it) => (
        <div key={it.id} className="ship-row">
          <Thumb src={it.image} />
          <div className="ship-meta"><b>{it.title}</b></div>
        </div>
      ))}
    </div>
  );
}

export default function Shipments() {
  useSeller();
  const [shipments, setShipments] = useState<Shipment[] | null>(null);
  const [held, setHeld] = useState<HeldItem[]>([]);
  const [error, setError] = useState('');

  const load = () => {
    getSellerShipments().then(setShipments).catch((e) => setError(e instanceof Error ? e.message : 'Failed to load.'));
    getSellerHeld().then(setHeld).catch(() => {});
  };
  useEffect(() => { void load(); }, []);

  const by = (st: string) => (shipments ?? []).filter((s) => s.status === st);
  const toConfirm = by('PAID');
  const making = by('LABEL_PENDING');
  const ready = by('LABEL_CREATED');
  const shipped = by('SHIPPED');
  const empty = shipments && toConfirm.length + making.length + ready.length + shipped.length === 0 && held.length === 0;

  return (
    <>
      <div className="acct-head">
        <h1 className="display acct-title">Shipments</h1>
        <p className="muted">We create and pay for every shipping label — you just print it, tape it on, and drop it off.</p>
      </div>

      <div className="ship-hero">
        <div className="ship-hero__badge"><Truck width={16} height={16} /> BIDit handles your shipping labels</div>
        <div className="ship-steps">
          <Step n={1} title="Confirm the size" body="Tell us the box size and weight." />
          <Step n={2} title="We make the label" body="We generate and pay for the carrier label." />
          <Step n={3} title="Print &amp; drop off" body="Print it, tape it on, hand it to the carrier." />
        </div>
      </div>

      {error && <div className="auth__error">{error}</div>}
      {empty && <EmptyState icon={Truck} title="No packages to ship yet" sub="When a buyer pays shipping on a card they won from you, it shows up here to fulfill." />}

      {toConfirm.length > 0 && (
        <Section title="Needs your confirmation" hint="The buyer paid shipping — confirm the package size and we’ll make the label.">
          {toConfirm.map((s) => <ConfirmCard key={s.id} shipment={s} onDone={load} />)}
        </Section>
      )}

      {making.length > 0 && (
        <Section title="Preparing your label" hint="We’re generating the label — you’ll get an email the moment it’s ready.">
          {making.map((s) => (
            <div key={s.id} className="card acct-card ship-card">
              <CardHead shipment={s} pill={<span className="ship-pill is-pending">Making label…</span>} />
              <Items shipment={s} />
              <p className="muted acct-note ship-hint">Your label is being created. Hang tight — we’ll email you when it’s ready to print.</p>
            </div>
          ))}
        </Section>
      )}

      {ready.length > 0 && (
        <Section title="Ready to ship" hint="Print the label, tape it to the package, and drop it at the carrier.">
          {ready.map((s) => <ReadyCard key={s.id} shipment={s} onShipped={load} />)}
        </Section>
      )}

      {held.length > 0 && (
        <Section title="Waiting for buyer’s shipping order" hint="Hold these until the buyer pays for shipping — then they’ll move up to be shipped.">
          <div className="card acct-card">
            <div className="ship-list">
              {held.map((it) => (
                <div key={it.id} className="ship-row">
                  <Thumb src={it.image} />
                  <div className="ship-meta">
                    <b>{it.title}</b>
                    <span className="muted">@{it.buyerHandle}{it.heldUntil ? ` · hold until ${fmtDate(it.heldUntil)}` : ''}</span>
                  </div>
                  <span className="ship-pill is-wait">Awaiting buyer</span>
                </div>
              ))}
            </div>
          </div>
        </Section>
      )}

      {shipped.length > 0 && (
        <Section title="Shipped">
          {shipped.map((s) => (
            <div key={s.id} className="card acct-card ship-card">
              <CardHead shipment={s} pill={<span className="acct-saved"><Check width={14} height={14} /> Shipped</span>} />
              <p className="muted acct-note ship-hint">
                {s.trackingNumber ? <>Tracking: <b>{s.carrier ? `${s.carrier} · ` : ''}{s.trackingNumber}</b></> : 'On its way to the buyer.'}
              </p>
            </div>
          ))}
        </Section>
      )}
    </>
  );
}

function Step({ n, title, body }: { n: number; title: string; body: string }) {
  return (
    <div className="ship-step">
      <span className="ship-step__n">{n}</span>
      <div><b>{title}</b><span className="muted">{body}</span></div>
    </div>
  );
}

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="ship-sec">
      <div className="ship-sec__head">
        <h2 className="acct-sub" style={{ margin: 0 }}>{title}</h2>
        {hint && <p className="muted ship-sec__hint">{hint}</p>}
      </div>
      {children}
    </section>
  );
}

function CardHead({ shipment, pill }: { shipment: Shipment; pill: React.ReactNode }) {
  const n = shipment.items.length;
  return (
    <div className="ship-card__head">
      <div>
        <b>To @{shipment.buyerHandle}</b>
        <span className="muted"> · {n} item{n > 1 ? 's' : ''}</span>
      </div>
      {pill}
    </div>
  );
}

function ConfirmCard({ shipment, onDone }: { shipment: Shipment; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [l, setL] = useState('10');
  const [w, setW] = useState('10');
  const [h, setH] = useState('2');
  const [g, setG] = useState('30');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const submit = async () => {
    const dims = { lengthCm: Number(l), widthCm: Number(w), heightCm: Number(h), weightGrams: Number(g) };
    if (Object.values(dims).some((n) => !Number.isFinite(n) || n <= 0)) {
      setErr('Enter a length, width, height, and weight greater than 0.');
      return;
    }
    setBusy(true); setErr('');
    try { await confirmShipmentLabel(shipment.id, dims); onDone(); }
    catch (e) { setErr(e instanceof Error ? e.message : 'Could not confirm.'); setBusy(false); }
  };

  return (
    <div className="card acct-card ship-card">
      <CardHead shipment={shipment} pill={<span className="ship-pill is-action">Action needed</span>} />
      <Items shipment={shipment} />

      {!open ? (
        <div className="acct-actions">
          <button className="btn btn-primary" onClick={() => setOpen(true)}>Confirm package size</button>
          <span className="muted ship-hint" style={{ alignSelf: 'center' }}>We’ll create the label from this.</span>
        </div>
      ) : (
        <div className="ship-confirm">
          <p className="muted ship-hint">Enter the packed box’s size and weight. Not sure? A single card in a bubble mailer is about <b>10 × 10 × 2 cm</b>, <b>~30 g</b>.</p>
          <div className="ship-dims">
            <Dim label="Length" unit="cm" value={l} onChange={setL} />
            <Dim label="Width" unit="cm" value={w} onChange={setW} />
            <Dim label="Height" unit="cm" value={h} onChange={setH} />
            <Dim label="Weight" unit="g" value={g} onChange={setG} />
          </div>
          {err && <div className="auth__error">{err}</div>}
          <div className="acct-actions">
            <button className="btn btn-primary" disabled={busy} onClick={submit}>{busy ? 'Creating…' : 'Create my label'}</button>
            <button className="btn btn-ghost" disabled={busy} onClick={() => { setOpen(false); setErr(''); }}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}

function Dim({ label, unit, value, onChange }: { label: string; unit: string; value: string; onChange: (v: string) => void }) {
  return (
    <div className="fld ship-dim">
      <label>{label} <span className="muted">{unit}</span></label>
      <input type="number" min="0" step="any" inputMode="decimal" value={value} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}

function ReadyCard({ shipment, onShipped }: { shipment: Shipment; onShipped: () => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const ship = async () => {
    setBusy(true); setErr('');
    try { await shipShipment(shipment.id); onShipped(); }
    catch (e) { setErr(e instanceof Error ? e.message : 'Could not mark shipped.'); setBusy(false); }
  };
  return (
    <div className="card acct-card ship-card ship-card--ready">
      <CardHead shipment={shipment} pill={<span className="ship-pill is-ready">Label ready</span>} />
      <Items shipment={shipment} />

      <div className="ship-ready">
        <div className="ship-ready__steps">
          <span><b>1.</b> Print the label</span>
          <span><b>2.</b> Tape it to the package</span>
          <span><b>3.</b> Drop it at {shipment.carrier || 'the carrier'}</span>
        </div>
        {shipment.trackingNumber && <p className="muted ship-hint">Tracking: <b>{shipment.carrier ? `${shipment.carrier} · ` : ''}{shipment.trackingNumber}</b></p>}
        {err && <div className="auth__error">{err}</div>}
        <div className="acct-actions">
          {shipment.labelUrl && (
            <a className="btn btn-primary" href={shipment.labelUrl} target="_blank" rel="noreferrer"><DownloadIcon /> Download label</a>
          )}
          <button className="btn btn-ghost" disabled={busy} onClick={ship}>{busy ? 'Saving…' : 'I’ve shipped it'}</button>
        </div>
      </div>
    </div>
  );
}
