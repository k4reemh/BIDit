import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { adminStats, type AdminStats, type StatsPoint, type Session } from '../../api';

const REFRESH_MS = 30_000; // launch-day dashboard: keep itself fresh

const money = (v: string) => `$${Number(v).toLocaleString(undefined, { maximumFractionDigits: 2 })}`;

/** Zero-safe bar chart: heights scale to the series max, quiet buckets show a
 *  minimal sliver so the timeline reads as continuous, not broken. */
function Bars({ series, label }: { series: StatsPoint[]; label: (t: number) => string }) {
  const max = Math.max(1, ...series.map((p) => p.n));
  return (
    <div className="adm-bars" role="img" aria-label="signup chart">
      {series.map((p) => (
        <div className="adm-bars__col" key={p.t} title={`${label(p.t)}: ${p.n} signup${p.n === 1 ? '' : 's'}`}>
          <div className="adm-bars__bar" style={{ height: `${Math.max(3, (p.n / max) * 100)}%`, opacity: p.n === 0 ? 0.25 : 1 }} />
        </div>
      ))}
    </div>
  );
}

const hourLabel = (t: number) =>
  new Date(t).toLocaleTimeString(undefined, { hour: 'numeric' });
const dayLabel = (t: number) =>
  new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

export default function AdminStatsPage({ session }: { session: Session | null }) {
  const [stats, setStats] = useState<AdminStats | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!session?.isAdmin) return;
    let alive = true;
    const load = () =>
      adminStats()
        .then((s) => alive && setStats(s))
        .catch((e) => alive && setError(e instanceof Error ? e.message : 'Failed to load.'));
    void load();
    const timer = setInterval(load, REFRESH_MS);
    return () => { alive = false; clearInterval(timer); };
  }, [session?.isAdmin]);

  if (!session) return <Gate>Sign in with an admin account.</Gate>;
  if (!session.isAdmin) {
    return <Gate>Your account isn’t an admin. Add your email to <code>BIDIT_ADMIN_EMAILS</code> on the backend.</Gate>;
  }

  const u = stats?.users;
  const m = stats?.money;

  return (
    <main className="admin">
      <div className="acct-head">
        <h1 className="display acct-title">Stats</h1>
        <p className="muted">Signups and money across the whole platform. Refreshes every {REFRESH_MS / 1000}s.</p>
        <div className="adm-nav">
          <Link to="/admin/stats" className="active">Stats</Link> <span>·</span>
          <Link to="/admin/sellers">Sellers</Link> <span>·</span>
          <Link to="/admin/orders">Orders</Link> <span>·</span>
          <Link to="/admin/shipments">Shipping</Link> <span>·</span>
          <Link to="/admin/users">Accounts</Link>
        </div>
      </div>

      {error && <div className="auth__error">{error}</div>}
      {!stats && !error && <p className="muted">Loading…</p>}

      {u && m && (
        <>
          <h3 className="acct-sub">Signups</h3>
          <div className="adm-tiles">
            <div className="card adm-tile"><span className="adm-tile__n">{u.total.toLocaleString()}</span><span className="muted">users all time</span></div>
            <div className="card adm-tile"><span className="adm-tile__n">{u.lastHour.toLocaleString()}</span><span className="muted">last hour</span></div>
            <div className="card adm-tile"><span className="adm-tile__n">{u.lastDay.toLocaleString()}</span><span className="muted">last 24 hours</span></div>
            <div className="card adm-tile"><span className="adm-tile__n">{u.last7d.toLocaleString()}</span><span className="muted">last 7 days</span></div>
            <div className="card adm-tile"><span className="adm-tile__n">{u.sellers.toLocaleString()}</span><span className="muted">sellers ({u.verifiedSellers} verified)</span></div>
          </div>

          <div className="adm-chartrow">
            <div className="card adm-chart">
              <div className="adm-chart__head"><b>Signups per hour</b><span className="muted">trailing 24h</span></div>
              <Bars series={u.hourly} label={hourLabel} />
            </div>
            <div className="card adm-chart">
              <div className="adm-chart__head"><b>Signups per day</b><span className="muted">trailing 14 days</span></div>
              <Bars series={u.daily} label={dayLabel} />
            </div>
          </div>

          <h3 className="acct-sub" style={{ marginTop: 26 }}>Money</h3>
          <div className="adm-tiles">
            <div className="card adm-tile"><span className="adm-tile__n">{money(m.gmvUsd)}</span><span className="muted">spent on orders ({m.orders.toLocaleString()})</span></div>
            <div className="card adm-tile"><span className="adm-tile__n">{money(m.feesUsd)}</span><span className="muted">platform fees ({m.releasedOrders.toLocaleString()} released)</span></div>
            <div className="card adm-tile"><span className="adm-tile__n adm-tile__n--accent">{money(m.buybackUsd)}</span><span className="muted">$BID buybacks ({m.buybacks.toLocaleString()})</span></div>
            <div className="card adm-tile"><span className="adm-tile__n">{money(m.depositedUsd)}</span><span className="muted">deposited all time</span></div>
            <div className="card adm-tile"><span className="adm-tile__n">{money(m.withdrawnUsd)}</span><span className="muted">withdrawn all time</span></div>
            <div className="card adm-tile"><span className="adm-tile__n">{money(m.refundedUsd)}</span><span className="muted">refunded ({m.refundedOrders.toLocaleString()})</span></div>
          </div>
          <p className="muted" style={{ fontSize: 13, marginTop: 10 }}>
            “Spent on orders” counts every order that wasn’t refunded or canceled. Fees are realized on released
            (settled) orders only, so they trail order volume while escrow is in flight.
          </p>
        </>
      )}
    </main>
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
