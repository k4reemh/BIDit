import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { getSellerApplications, verifySellerAdmin, type SellerApplication, type Session } from '../../api';
import { Check } from '../../icons';

const fmt = (ms: number | null) =>
  ms ? new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '—';

export default function AdminSellers({ session }: { session: Session | null }) {
  const [rows, setRows] = useState<SellerApplication[] | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  const load = () =>
    getSellerApplications().then(setRows).catch((e) => setError(e instanceof Error ? e.message : 'Failed to load.'));
  useEffect(() => {
    if (session?.isAdmin) void load();
  }, [session?.isAdmin]);

  if (!session) return <Gate>Sign in with an admin account.</Gate>;
  if (!session.isAdmin) return <Gate>Your account isn’t an admin. Add your email to <code>BIDIT_ADMIN_EMAILS</code> on the backend.</Gate>;

  const verify = async (userId: string) => {
    setBusy(userId);
    try {
      await verifySellerAdmin(userId);
      await load();
    } finally {
      setBusy(null);
    }
  };

  const pending = (rows ?? []).filter((r) => !r.verified);
  const verified = (rows ?? []).filter((r) => r.verified);

  return (
    <main className="admin">
      <div className="acct-head">
        <div className="adm-nav"><Link to="/admin/sellers" className="active">Sellers</Link> <span>·</span> <Link to="/admin/orders">Orders</Link></div>
        <h1 className="display acct-title">Seller applications</h1>
        <p className="muted">Everyone who’s applied to sell. Verify trusted sellers to grant the badge + priority dispute support.</p>
      </div>
      {error && <div className="auth__error">{error}</div>}

      <h2 className="acct-sub" style={{ fontSize: 16, marginTop: 8 }}>Unverified · {pending.length}</h2>
      {rows && pending.length === 0 && <p className="muted">No unverified sellers.</p>}
      {pending.map((r) => <Row key={r.userId} r={r} onVerify={verify} busy={busy === r.userId} />)}

      {verified.length > 0 && <h2 className="acct-sub" style={{ fontSize: 16, marginTop: 26 }}>Verified · {verified.length}</h2>}
      {verified.map((r) => <Row key={r.userId} r={r} onVerify={verify} busy={busy === r.userId} />)}
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

function Row({ r, onVerify, busy }: { r: SellerApplication; onVerify: (id: string) => void; busy: boolean }) {
  const s = r.socials ?? {};
  const socialStr = [s.x && `X ${s.x}`, s.instagram && `IG ${s.instagram}`, s.tiktok && `TT ${s.tiktok}`].filter(Boolean).join(' · ');
  return (
    <div className="card acct-card adm-row">
      <div className="adm-row__head">
        <div className="adm-row__id">
          <b>{r.displayName || r.handle}</b> <span className="muted">@{r.handle}</span>
          {r.verified ? (
            <span className="vbadge"><Check width={12} height={12} /> Verified</span>
          ) : (
            <span className="vbadge vbadge--pending">{r.fulfilledCount}/{r.threshold} to Verified</span>
          )}
        </div>
        {!r.verified && (
          <button className="btn btn-primary btn-sm" onClick={() => onVerify(r.userId)} disabled={busy}>
            {busy ? 'Verifying…' : 'Verify'}
          </button>
        )}
      </div>
      <div className="adm-row__grid">
        <span><b>Email</b> {r.email ?? '—'}</span>
        <span><b>Applied</b> {fmt(r.appliedAt)}</span>
        <span><b>Fulfilled</b> {r.fulfilledCount}/{r.threshold}</span>
        <span><b>Onboarded</b> {r.onboarded ? 'yes' : 'no'}</span>
        <span><b>Coin</b> {r.pumpCoinAddress ? `${r.pumpCoinAddress.slice(0, 8)}…` : '—'}</span>
        <span><b>Ships from</b> {[r.origin.city, r.origin.region, r.origin.country].filter(Boolean).join(', ') || '—'}</span>
        <span><b>Website</b> {r.website ?? '—'}</span>
        <span><b>Socials</b> {socialStr || '—'}</span>
      </div>
      {r.pitch && <p className="muted adm-row__pitch">“{r.pitch}”</p>}
    </div>
  );
}
