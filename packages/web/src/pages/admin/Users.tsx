import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { adminFindUsers, adminBanUser, adminUnbanUser, type AdminUser, type Session } from '../../api';
import { Shield } from '../../icons';

const fmt = (ms: number | null) =>
  ms ? new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : 'n/a';

/**
 * Admin: suspend an account.
 *
 * A ban is reversible and destroys nothing. The row, its ledger and its orders
 * survive, so escrow that is already in flight can still settle and a mistaken
 * ban can be lifted. Permanent removal is the separate erasure path.
 */
export default function AdminUsers({ session }: { session: Session | null }) {
  const [q, setQ] = useState('');
  const [rows, setRows] = useState<AdminUser[] | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [reason, setReason] = useState<Record<string, string>>({});

  const load = (query = q) =>
    adminFindUsers(query)
      .then(setRows)
      .catch((e) => setError(e instanceof Error ? e.message : 'Failed to load.'));

  useEffect(() => {
    if (session?.isAdmin) void load('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.isAdmin]);

  if (!session) return <Gate>Sign in with an admin account.</Gate>;
  if (!session.isAdmin) {
    return <Gate>Your account isn’t an admin. Add your email to <code>BIDIT_ADMIN_EMAILS</code> on the backend.</Gate>;
  }

  const ban = async (u: AdminUser) => {
    if (!window.confirm(`Suspend @${u.handle}? They are signed out immediately and cannot sign back in.`)) return;
    setBusy(u.id);
    setError('');
    try {
      await adminBanUser(u.id, reason[u.id]?.trim() || null);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not suspend that account.');
    } finally {
      setBusy(null);
    }
  };

  const unban = async (u: AdminUser) => {
    setBusy(u.id);
    setError('');
    try {
      await adminUnbanUser(u.id);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not lift that suspension.');
    } finally {
      setBusy(null);
    }
  };

  return (
    <main className="admin">
      <div className="acct-head">
        <h1 className="display acct-title">Accounts</h1>
        <p className="muted">Search by username or email. With the box empty this lists everyone currently suspended.</p>
        <div className="adm-nav">
          <Link to="/admin/sellers">Sellers</Link> <span>·</span>
          <Link to="/admin/orders">Orders</Link> <span>·</span>
          <Link to="/admin/shipments">Shipping</Link> <span>·</span>
          <Link to="/admin/users" className="active">Accounts</Link>
        </div>
      </div>

      <form
        className="adm-search"
        onSubmit={(e) => { e.preventDefault(); void load(); }}
      >
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Username or email" aria-label="Search accounts" />
        <button className="btn btn-ghost btn-sm" type="submit">Search</button>
      </form>

      {error && <div className="auth__error">{error}</div>}

      {rows === null ? (
        <p className="muted">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="muted">{q ? 'No account matches that.' : 'Nobody is suspended.'}</p>
      ) : (
        <div className="card acct-card adm-users">
          {rows.map((u) => (
            <div className={`adm-user${u.bannedAt ? ' is-banned' : ''}`} key={u.id}>
              <div className="adm-user__id">
                <b>@{u.handle}</b>
                {u.role === 'admin' && <span className="adm-user__tag">Admin</span>}
                {u.bannedAt && <span className="adm-user__tag adm-user__tag--ban">Suspended</span>}
                {!u.emailVerified && <span className="adm-user__tag adm-user__tag--warn">Unverified</span>}
                <span className="muted">{u.email ?? 'no email'} · joined {fmt(u.createdAt)}</span>
                {u.bannedReason && <span className="muted adm-user__reason">Reason: {u.bannedReason}</span>}
              </div>
              {u.role === 'admin' ? (
                <span className="muted adm-user__note">Admins can’t be suspended here.</span>
              ) : u.bannedAt ? (
                <button className="btn btn-ghost btn-sm" onClick={() => void unban(u)} disabled={busy === u.id}>
                  {busy === u.id ? 'Working…' : 'Lift suspension'}
                </button>
              ) : (
                <div className="adm-user__act">
                  <input
                    className="adm-user__reasonin"
                    value={reason[u.id] ?? ''}
                    onChange={(e) => setReason((r) => ({ ...r, [u.id]: e.target.value }))}
                    placeholder="Reason (shown to them)"
                    aria-label={`Reason for suspending ${u.handle}`}
                  />
                  <button className="btn btn-danger btn-sm" onClick={() => void ban(u)} disabled={busy === u.id}>
                    <Shield width={14} height={14} /> {busy === u.id ? 'Working…' : 'Suspend'}
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
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
