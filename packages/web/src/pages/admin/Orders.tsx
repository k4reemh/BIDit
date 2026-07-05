import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { getAdminOrders, adminOrderAction, type AdminOrder, type Session } from '../../api';

const fmt = (ms: number | null) => (ms ? new Date(ms).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—');

/** Valid admin actions per order status (mirrors the escrow state machine). */
function actionsFor(status: string): { label: string; action: string; danger?: boolean }[] {
  switch (status) {
    case 'LOCKED':
      return [{ label: 'Mark shipped', action: 'ship' }];
    case 'SHIPPED':
      return [{ label: 'Mark delivered', action: 'deliver' }];
    case 'DISPUTE_WINDOW':
      return [{ label: 'Release to seller', action: 'release' }, { label: 'Open dispute', action: 'dispute', danger: true }];
    case 'DISPUTED':
      return [{ label: 'Release to seller', action: 'release-disputed' }, { label: 'Refund buyer', action: 'refund', danger: true }];
    default:
      return [];
  }
}

export default function AdminOrders({ session }: { session: Session | null }) {
  const [orders, setOrders] = useState<AdminOrder[] | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  const load = () => getAdminOrders().then(setOrders).catch((e) => setError(e instanceof Error ? e.message : 'Failed to load.'));
  useEffect(() => {
    if (session?.isAdmin) void load();
  }, [session?.isAdmin]);

  if (!session) return <Gate>Sign in with an admin account.</Gate>;
  if (!session.isAdmin) return <Gate>Your account isn’t an admin. Add your email to <code>BIDIT_ADMIN_EMAILS</code> on the backend.</Gate>;

  const act = async (orderId: string, action: string) => {
    setBusy(orderId + action);
    setError('');
    try {
      await adminOrderAction(orderId, action);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Action failed.');
    } finally {
      setBusy(null);
    }
  };

  return (
    <main className="admin">
      <div className="acct-head">
        <div className="adm-nav"><Link to="/admin/sellers">Sellers</Link> <span>·</span> <Link to="/admin/orders" className="active">Orders</Link></div>
        <h1 className="display acct-title">Orders</h1>
        <p className="muted">Drive the escrow flow: shipped → delivered → released. Funds release once an order clears its dispute window (auto after the window, or release here).</p>
      </div>
      {error && <div className="auth__error">{error}</div>}
      {orders && orders.length === 0 && <p className="muted">No orders yet. (In direct-payout mode, sales settle instantly and won’t appear here as held orders.)</p>}

      {(orders ?? []).map((o) => {
        const actions = actionsFor(o.status);
        return (
          <div key={o.id} className="card acct-card adm-row">
            <div className="adm-row__head">
              <div className="adm-row__id">
                <b>{o.title}</b> <span className="muted">@{o.buyer} → @{o.seller}</span>
                <span className={`ord-pill ord-pill--${o.status.toLowerCase()}`}>{o.status.replace(/_/g, ' ')}</span>
              </div>
              <div className="adm-actions">
                {actions.map((a) => (
                  <button key={a.action} className={`btn btn-sm ${a.danger ? 'btn-ghost' : 'btn-primary'}`} disabled={busy === o.id + a.action} onClick={() => act(o.id, a.action)}>
                    {busy === o.id + a.action ? '…' : a.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="adm-row__grid">
              <span><b>Amount</b> ${o.amount}</span>
              <span><b>Seller gets</b> ${o.sellerProceeds}</span>
              <span><b>Fee</b> ${o.platformFee}</span>
              <span><b>Ordered</b> {fmt(o.createdAt)}</span>
              <span><b>Tracking</b> {o.trackingNumber ?? '—'}</span>
              {o.status === 'DISPUTE_WINDOW' && <span><b>Auto-releases</b> {fmt(o.disputeWindowEndsAt)}</span>}
              {o.status === 'LOCKED' && <span><b>Ship by</b> {fmt(o.noShipDeadline)}</span>}
            </div>
          </div>
        );
      })}
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
