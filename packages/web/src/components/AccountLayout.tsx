import { NavLink, Outlet, useOutletContext } from 'react-router-dom';
import Avatar from './Avatar';
import { Person, Truck, Wallet, Bookmark, Bag, Bolt, Settings, UserCheck } from '../icons';
import type { Session } from '../api';

interface Ctx {
  session: Session;
  setSession: (s: Session) => void;
}
export const useAccount = () => useOutletContext<Ctx>();

const NAV = [
  { to: '/profile', label: 'Profile', icon: Person },
  { to: '/shipping', label: 'Payments & Shipping', icon: Truck },
  { to: '/deposit', label: 'Deposit', icon: Wallet },
  { to: '/saved', label: 'Saved', icon: Bookmark },
  { to: '/purchases', label: 'Purchases', icon: Bag },
  { to: '/ship', label: 'Ready to ship', icon: Truck },
  { to: '/bids', label: 'Bids & Offers', icon: Bolt },
];

export default function AccountLayout({
  session,
  setSession,
  onAuth,
}: {
  session: Session | null;
  setSession: (s: Session) => void;
  onAuth: () => void;
}) {
  if (!session) {
    return (
      <main className="container acct-gate">
        <div className="acct-gate__card card">
          <h1 className="display">Sign in to view your account</h1>
          <p className="muted">Your profile, shipping, deposits and purchases live here.</p>
          <button className="btn btn-primary" onClick={onAuth}>Sign in</button>
        </div>
      </main>
    );
  }

  const name = session.displayName || session.handle;
  return (
    <main className="container acct">
      <aside className="acct__side">
        <div className="acct__me">
          <Avatar handle={session.handle} src={session.avatarUrl} size={46} />
          <div className="acct__meid">
            <b>{name}</b>
            <span className="muted">@{session.handle}</span>
          </div>
        </div>
        <nav className="acct__nav">
          {NAV.map((n) => (
            <NavLink key={n.to} to={n.to} className={({ isActive }) => `acct__link${isActive ? ' active' : ''}`}>
              <n.icon width={19} height={19} /> {n.label}
            </NavLink>
          ))}
          <div className="acct__navdiv" />
          <NavLink to="/sell" className="acct__link"><UserCheck width={19} height={19} /> Become a seller</NavLink>
          <NavLink to="/settings" className="acct__link"><Settings width={19} height={19} /> Settings</NavLink>
        </nav>
      </aside>
      <section className="acct__main">
        <Outlet context={{ session, setSession } satisfies Ctx} />
      </section>
    </main>
  );
}
