import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAccount } from '../../components/AccountLayout';
import EmptyState from '../../components/EmptyState';
import { getPurchases, type Purchase } from '../../api';
import { Bag, Check } from '../../icons';

function Thumb({ src }: { src: string | null }) {
  return src
    ? <img className="ship-thumb" src={src} alt="" onError={(e) => (e.currentTarget.style.visibility = 'hidden')} />
    : <div className="ship-thumb ship-thumb--ph" />;
}

function Row({ p }: { p: Purchase }) {
  return (
    <div className="ship-row">
      <Thumb src={p.image} />
      <div className="ship-meta">
        <b>{p.title}</b>
        <span className="muted">${p.amount}</span>
      </div>
      {p.stage === 'to_ship' && <Link className="btn btn-primary btn-sm" to="/ship">Ship item</Link>}
      {p.stage === 'in_transit' && (
        <span className="ship-pill is-pending">
          {p.tracking ? <>{p.carrier ? `${p.carrier} · ` : ''}{p.tracking}</> : 'Preparing'}
        </span>
      )}
      {p.stage === 'delivered' && <span className="acct-saved"><Check width={14} height={14} /> Delivered</span>}
    </div>
  );
}

function Section({ title, hint, items }: { title: string; hint?: string; items: Purchase[] }) {
  if (items.length === 0) return null;
  return (
    <section className="ship-sec">
      <div className="ship-sec__head">
        <h2 className="acct-sub" style={{ margin: 0 }}>{title}</h2>
        {hint && <p className="muted ship-sec__hint">{hint}</p>}
      </div>
      <div className="card acct-card"><div className="ship-list">{items.map((p) => <Row key={p.id} p={p} />)}</div></div>
    </section>
  );
}

export default function Purchases() {
  useAccount();
  const [items, setItems] = useState<Purchase[] | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    getPurchases().then(setItems).catch((e) => setError(e instanceof Error ? e.message : 'Failed to load.'));
  }, []);

  const toShip = (items ?? []).filter((p) => p.stage === 'to_ship');
  const inTransit = (items ?? []).filter((p) => p.stage === 'in_transit');
  const delivered = (items ?? []).filter((p) => p.stage === 'delivered');
  const empty = items && items.length === 0;

  return (
    <>
      <div className="acct-head">
        <h1 className="display acct-title">Purchases</h1>
        <p className="muted">Everything you win, from the buzzer to your doorstep.</p>
      </div>

      {error && <div className="auth__error">{error}</div>}
      {empty && (
        <EmptyState
          icon={Bag}
          title="No purchases yet"
          sub="Win an auction or buy from a shop and it’ll show up here — we’ll track it all the way to delivered."
          ctaText="Find something to win"
          ctaTo="/"
        />
      )}

      <Section title="Ready to ship" hint="You won these — send them your way." items={toShip} />
      <Section title="On the way" hint="Shipped and heading to you." items={inTransit} />
      <Section title="Delivered" items={delivered} />

      {!items && !error && <p className="muted" style={{ padding: 8 }}>Loading…</p>}
    </>
  );
}
