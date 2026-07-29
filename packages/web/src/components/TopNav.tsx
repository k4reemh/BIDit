import { useEffect, useRef, useState } from 'react';
import { NavLink, Link, useNavigate } from 'react-router-dom';
import Logo from './Logo';
import Avatar from './Avatar';
import ProfileMenu from './ProfileMenu';
import NotificationBell from './NotificationBell';
import ThemeToggle from './ThemeToggle';
import { Search, GitHub, Gift, XLogo, Chevron, Wallet, ArrowRight } from '../icons';
import { money2 } from '../api';
import { FEATURED_CATEGORIES } from '../data';
import type { User } from '../App';

export default function TopNav({
  user,
  onAuth,
  onLogout,
  onReplayTutorial,
}: {
  user: User | null;
  onAuth: (mode: 'signup' | 'signin') => void;
  onLogout: () => void;
  onReplayTutorial?: () => void;
}) {
  const [menu, setMenu] = useState(false);
  const [cats, setCats] = useState(false);
  const [q, setQ] = useState('');
  const nav = useNavigate();
  const searchRef = useRef<HTMLInputElement>(null);
  const catsRef = useRef<HTMLDivElement>(null);

  // "/" focuses search from anywhere — the kbd hint in the box is a real shortcut.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      e.preventDefault();
      searchRef.current?.focus();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Categories menu closes on outside click or Escape, like any proper popover.
  useEffect(() => {
    if (!cats) return;
    const onDown = (e: MouseEvent) => {
      if (!catsRef.current?.contains(e.target as Node)) setCats(false);
    };
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setCats(false);
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onEsc);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onEsc);
    };
  }, [cats]);

  const submitSearch = () => {
    const s = q.trim();
    nav(s ? `/browse?q=${encodeURIComponent(s)}` : '/browse');
    searchRef.current?.blur();
  };

  return (
    <header className="nav">
      <div className="nav__inner container">
        <div className="nav__left">
          <Logo />
          <nav className="nav__links">
            <NavLink to="/" className={({ isActive }) => (isActive ? 'active' : '')} end>
              Live
            </NavLink>
            <NavLink to="/browse" className={({ isActive }) => (isActive ? 'active' : '')}>
              Browse
            </NavLink>
            <div className="nav__catwrap" ref={catsRef}>
              <button
                className={`nav__cat${cats ? ' open' : ''}`}
                aria-haspopup="menu"
                aria-expanded={cats}
                onClick={() => setCats((v) => !v)}
              >
                Categories <Chevron width={15} height={15} />
              </button>
              {cats && (
                <div className="nav__catmenu" role="menu">
                  {FEATURED_CATEGORIES.map((c) => (
                    <Link
                      key={c.name}
                      role="menuitem"
                      className="nav__catitem"
                      to={`/browse?cat=${encodeURIComponent(c.name)}`}
                      onClick={() => setCats(false)}
                    >
                      <img src={c.image} alt="" loading="lazy" />
                      <span>{c.name}</span>
                    </Link>
                  ))}
                  <Link className="nav__catall" role="menuitem" to="/browse" onClick={() => setCats(false)}>
                    Browse everything <ArrowRight width={15} height={15} />
                  </Link>
                </div>
              )}
            </div>
            <Link to="/sell">Sell</Link>
            <NavLink to="/leaderboard" className={({ isActive }) => `nav__lb${isActive ? ' active' : ''}`}>
              Leaderboard
            </NavLink>
          </nav>
        </div>

        <form
          className="nav__search"
          role="search"
          onSubmit={(e) => {
            e.preventDefault();
            submitSearch();
          }}
        >
          <Search width={18} height={18} />
          <input
            ref={searchRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              // Belt and braces: some embedded browsers skip implicit form
              // submission for a lone input, so Enter is handled directly too.
              if (e.key === 'Enter') {
                e.preventDefault();
                submitSearch();
              }
            }}
            placeholder="Search streams, sellers, categories"
            aria-label="Search live streams"
          />
          <kbd>/</kbd>
        </form>

        <div className="nav__right">
          <NavLink className="nav__docs" to="/docs">Docs</NavLink>
          <a className="icon-btn" href="https://x.com/biditsol" target="_blank" rel="noreferrer" aria-label="BIDit on X">
            <XLogo width={18} height={18} />
          </a>
          <a className="icon-btn" href="https://github.com/k4reemh/BIDit1" target="_blank" rel="noreferrer" aria-label="BIDit on GitHub">
            <GitHub width={19} height={19} />
          </a>
          <ThemeToggle />
          {user ? (
            <>
              <Link className="nav__bal" to="/deposit" title="Your wallet balance"><Wallet width={15} height={15} /> ${money2(user.settled)}</Link>
              <NotificationBell />
              <Link className="icon-btn" to="/points" aria-label="BIDit Points"><Gift /></Link>
              <button className="nav__avatar" onClick={() => setMenu((v) => !v)} aria-label="Account">
                <Avatar handle={user.handle} src={user.avatarUrl} size={36} />
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

      {user && menu && <ProfileMenu user={user} onClose={() => setMenu(false)} onLogout={onLogout} onReplayTutorial={onReplayTutorial} />}
    </header>
  );
}
