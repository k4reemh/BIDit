import { useState } from 'react';
import { NavLink, Link } from 'react-router-dom';
import Logo from './Logo';
import Avatar from './Avatar';
import ProfileMenu from './ProfileMenu';
import NotificationBell from './NotificationBell';
import ThemeToggle from './ThemeToggle';
import { Search, Chat, Gift, XLogo, Chevron, Wallet } from '../icons';
import type { User } from '../App';

export default function TopNav({
  user,
  onAuth,
  onLogout,
}: {
  user: User | null;
  onAuth: (mode: 'signup' | 'signin') => void;
  onLogout: () => void;
}) {
  const [menu, setMenu] = useState(false);

  return (
    <header className="nav">
      <div className="nav__inner container">
        <div className="nav__left">
          <Logo />
          <nav className="nav__links">
            <NavLink to="/" className={({ isActive }) => (isActive ? 'active' : '')} end>
              Live
            </NavLink>
            <a href="#featured">Browse</a>
            <button className="nav__cat">
              Categories <Chevron width={15} height={15} />
            </button>
            <Link to="/sell">Sell</Link>
          </nav>
        </div>

        <label className="nav__search">
          <Search width={18} height={18} />
          <input placeholder="Search live auctions, cards, sellers…" />
          <kbd>/</kbd>
        </label>

        <div className="nav__right">
          <NavLink className="nav__docs" to="/docs">Docs</NavLink>
          <a className="icon-btn" href="https://x.com/biditsol" target="_blank" rel="noreferrer" aria-label="BIDit on X">
            <XLogo width={18} height={18} />
          </a>
          <ThemeToggle />
          {user ? (
            <>
              <Link className="nav__bal" to="/deposit" title="Your wallet balance"><Wallet width={15} height={15} /> ${user.settled}</Link>
              <button className="icon-btn" aria-label="Messages"><Chat /></button>
              <NotificationBell />
              <button className="icon-btn" aria-label="Rewards"><Gift /></button>
              <button className="nav__avatar" onClick={() => setMenu((v) => !v)} aria-label="Account">
                <Avatar handle={user.handle} size={36} />
              </button>
            </>
          ) : (
            <>
              <button className="btn btn-ghost btn-sm" onClick={() => onAuth('signin')}>Sign in</button>
              <button className="btn btn-primary btn-sm" onClick={() => onAuth('signup')}>Sign up</button>
            </>
          )}
        </div>
      </div>

      {user && menu && <ProfileMenu user={user} onClose={() => setMenu(false)} onLogout={onLogout} />}
    </header>
  );
}
