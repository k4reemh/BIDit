import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { getSellerApplications, verifySellerAdmin, adminReassignCoin, getAdminPromo, markPromoPaid, type SellerApplication, type AdminPromo, type Session } from '../../api';
import { Check } from '../../icons';

const fmt = (ms: number | null) =>
  ms ? new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '—';

export default function AdminSellers({ session }: { session: Session | null }) {
  const [rows, setRows] = useState<SellerApplication[] | null>(null);
  const [promo, setPromo] = useState<AdminPromo | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  const load = () =>
    getSellerApplications().then(setRows).catch((e) => setError(e instanceof Error ? e.message : 'Failed to load.'));
  const loadPromo = () => getAdminPromo().then(setPromo).catch(() => {});
  useEffect(() => {
    if (session?.isAdmin) { void load(); void loadPromo(); }
  }, [session?.isAdmin]);

  const pay = async (userId: string) => {
    setBusy('pay:' + userId);
    try { await markPromoPaid(userId); await loadPromo(); } finally { setBusy(null); }
  };

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
        <div className="adm-nav"><Link to="/admin/sellers" className="active">Sellers</Link> <span>·</span> <Link to="/admin/orders">Orders</Link> <span>·</span> <Link to="/admin/shipments">Shipping</Link></div>
        <h1 className="display acct-title">Seller applications</h1>
        <p className="muted">Everyone who’s applied to sell. Verify trusted sellers to grant the badge + priority dispute support.</p>
      </div>
      {error && <div className="auth__error">{error}</div>}

      {promo?.configured && (
        <section>
          <h2 className="acct-sub" style={{ fontSize: 16, marginTop: 8 }}>
            Launch ${promo.bonusUsd} promo · {promo.sellers.length} enrolled {promo.active ? '· signups open' : '· signups closed'}
          </h2>
          <p className="muted" style={{ marginBottom: 10 }}>
            Sellers who joined in the first 3 days. Once someone hits ${promo.bonusUsd} fulfilled, send the ${promo.bonusUsd} USDC bonus <b>manually to their wallet</b>, then mark it paid. This list moves no treasury funds.
          </p>
          {promo.sellers.length === 0 && <p className="muted">No enrolled sellers yet.</p>}
          {promo.sellers.map((s) => (
            <div className="card acct-card adm-row" key={s.userId}>
              <div className="adm-row__head">
                <div className="adm-row__id">
                  <b>@{s.handle}</b>
                  {s.earned ? (
                    s.paidAt ? (
                      <span className="vbadge"><Check width={12} height={12} /> Bonus paid</span>
                    ) : (
                      <span className="vbadge vbadge--pending">Eligible — pay ${promo.bonusUsd}</span>
                    )
                  ) : (
                    <span className="muted">${s.fulfilledUsd} / ${promo.bonusUsd} fulfilled</span>
                  )}
                </div>
                {s.earned && !s.paidAt && (
                  <button className="btn btn-primary btn-sm" onClick={() => pay(s.userId)} disabled={busy === 'pay:' + s.userId}>
                    {busy === 'pay:' + s.userId ? 'Saving…' : `Mark $${promo.bonusUsd} paid`}
                  </button>
                )}
              </div>
              <div className="adm-row__grid">
                <span><b>Fulfilled</b> ${s.fulfilledUsd} / ${promo.bonusUsd}</span>
                <span><b>Joined</b> {fmt(s.joinedAt)}</span>
                <span><b>Email</b> {s.email ?? '—'}</span>
                <span><b>Payout wallet</b> {s.payoutWalletAddress ? `${s.payoutWalletAddress.slice(0, 10)}…` : '—'}</span>
                <span><b>Bonus paid</b> {s.paidAt ? fmt(s.paidAt) : '—'}</span>
              </div>
            </div>
          ))}
        </section>
      )}

      <h2 className="acct-sub" style={{ fontSize: 16, marginTop: 26 }}>Unverified · {pending.length}</h2>
      {rows && pending.length === 0 && <p className="muted">No unverified sellers.</p>}
      {pending.map((r) => <Row key={r.userId} r={r} onVerify={verify} busy={busy === r.userId} onDone={load} />)}

      {verified.length > 0 && <h2 className="acct-sub" style={{ fontSize: 16, marginTop: 26 }}>Verified · {verified.length}</h2>}
      {verified.map((r) => <Row key={r.userId} r={r} onVerify={verify} busy={busy === r.userId} onDone={load} />)}
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

function Row({ r, onVerify, busy, onDone }: { r: SellerApplication; onVerify: (id: string) => void; busy: boolean; onDone: () => void }) {
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
      <ReassignCoin userId={r.userId} current={r.pumpCoinAddress} onDone={onDone} />
    </div>
  );
}

/** Admin escape hatch: bind a coin to this seller (force-moves it off any other
 *  seller). Self-serve claiming is first-claim-wins, so this is how a legit coin
 *  transfer / dispute gets resolved. */
function ReassignCoin({ userId, current, onDone }: { userId: string; current: string | null; onDone: () => void }) {
  const [coin, setCoin] = useState(current ?? '');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const submit = async () => {
    if (!coin.trim()) { setMsg('Enter a coin address.'); return; }
    setBusy(true); setMsg('');
    try { await adminReassignCoin(userId, coin.trim()); setMsg('Coin reassigned.'); onDone(); }
    catch (e) { setMsg(e instanceof Error ? e.message : 'Could not reassign.'); }
    finally { setBusy(false); }
  };
  return (
    <div className="adm-reassign">
      <input className="adm-reassign__in" value={coin} onChange={(e) => setCoin(e.target.value)} placeholder="Bind a pump.fun coin to this seller…" />
      <button className="btn btn-ghost btn-sm" onClick={submit} disabled={busy}>{busy ? 'Saving…' : 'Reassign coin'}</button>
      {msg && <span className="muted adm-reassign__msg">{msg}</span>}
    </div>
  );
}
