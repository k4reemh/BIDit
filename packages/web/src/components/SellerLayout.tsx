import { useState } from 'react';
import { NavLink, Outlet, useOutletContext } from 'react-router-dom';
import Avatar from './Avatar';
import SellerOnboarding from './SellerOnboarding';
import { applySeller, type Session } from '../api';
import { Grid, Radio, Tag, Truck, Wallet, Settings, Check, ArrowRight, Bag } from '../icons';

interface Ctx {
  session: Session;
  setSession: (s: Session) => void;
}
export const useSeller = () => useOutletContext<Ctx>();

const NAV = [
  { to: '/seller', label: 'Overview', icon: Grid, end: true },
  { to: '/seller/live', label: 'Live', icon: Radio },
  { to: '/seller/listings', label: 'Listings', icon: Tag },
  { to: '/seller/shipments', label: 'Shipments', icon: Truck },
  { to: '/seller/orders', label: 'Orders', icon: Bag },
  { to: '/seller/payouts', label: 'Payouts', icon: Wallet },
  { to: '/seller/settings', label: 'Settings', icon: Settings },
];

const PERKS = [
  'Run live auctions + randomizer wheels right on your pump.fun stream',
  'Get paid in USDC — funds held in escrow until the card ships',
  'Every sale routes 4% into the $BID buyback + 1% to a buyer-protection treasury',
];

export default function SellerLayout({
  session,
  setSession,
  onAuth,
}: {
  session: Session | null;
  setSession: (s: Session) => void;
  onAuth: () => void;
}) {
  const [busy, setBusy] = useState(false);

  if (!session) {
    return (
      <main className="container acct-gate">
        <div className="acct-gate__card card">
          <h1 className="display">Sign in to start selling</h1>
          <p className="muted">Your seller studio, live auctions and payouts live here.</p>
          <button className="btn btn-primary" onClick={onAuth}>Sign in</button>
        </div>
      </main>
    );
  }

  if (!session.isSeller) {
    const apply = async () => {
      setBusy(true);
      try {
        setSession(await applySeller());
      } finally {
        setBusy(false);
      }
    };
    return (
      <main className="container sell-apply">
        <div className="sell-apply__card card">
          <span className="hero__tag"><span className="dot" /> Seller studio</span>
          <h1 className="display sell-apply__title">Turn your stream into an auction house.</h1>
          <p className="muted">List anything, run live auctions and wheel spins, and get paid in USDC — setup takes a minute.</p>
          <ul className="sell-apply__perks">
            {PERKS.map((p) => (
              <li key={p}><span className="sell-apply__check"><Check width={14} height={14} /></span>{p}</li>
            ))}
          </ul>
          <button className="btn btn-primary btn-lg" onClick={apply} disabled={busy}>
            {busy ? 'Setting up…' : 'Become a seller'} {!busy && <ArrowRight width={18} height={18} />}
          </button>
          <p className="sell-apply__note muted">You’re approved instantly and can start right away. Fulfill 10 orders to become a <b>Verified Seller</b>.</p>
        </div>
      </main>
    );
  }

  if (!session.sellerOnboarded) {
    return <SellerOnboarding session={session} setSession={setSession} />;
  }

  const name = session.displayName || session.handle;
  return (
    <main className="container sl">
      <aside className="sl__side">
        <div className="sl__brand">
          <Avatar handle={session.handle} size={42} />
          <div className="sl__brandid">
            <b>{name}</b>
            {session.verified ? (
              <span className="sl__badge"><Check width={12} height={12} /> Verified seller</span>
            ) : (
              <span className="sl__badge sl__badge--pending">Seller · {session.fulfilledCount ?? 0}/{session.verifyThreshold ?? 10} to Verified</span>
            )}
          </div>
        </div>
        <nav className="acct__nav">
          {NAV.map((n) => (
            <NavLink key={n.to} to={n.to} end={n.end} className={({ isActive }) => `acct__link${isActive ? ' active' : ''}`}>
              <n.icon width={19} height={19} /> {n.label}
            </NavLink>
          ))}
        </nav>
      </aside>
      <section className="sl__main">
        <Outlet context={{ session, setSession } satisfies Ctx} />
      </section>
    </main>
  );
}
