import { useNavigate, useLocation } from 'react-router-dom';
import Avatar from './Avatar';
import { Bolt, Tag, Wallet, Person } from '../icons';
import type { User } from '../App';

const ACCOUNT_PATHS = ['/profile', '/shipping', '/saved', '/purchases', '/ship', '/bids', '/settings'];

/**
 * App-style bottom navigation for phones (hidden on desktop via CSS). Gives the
 * installed PWA a native feel and a way to move around without the browser's
 * back button in standalone mode. Auth-gated tabs open the sign-in modal.
 */
export default function MobileTabBar({
  user,
  onAuth,
}: {
  user: User | null;
  onAuth: (mode: 'signup' | 'signin') => void;
}) {
  const nav = useNavigate();
  const { pathname } = useLocation();

  const tabs = [
    {
      key: 'live',
      label: 'Live',
      icon: <Bolt width={22} height={22} />,
      active: pathname === '/' || pathname.startsWith('/live'),
      onClick: () => nav('/'),
    },
    {
      key: 'sell',
      label: 'Sell',
      icon: <Tag width={22} height={22} />,
      active: pathname === '/sell' || pathname.startsWith('/seller'),
      onClick: () => nav('/seller'),
    },
    {
      key: 'wallet',
      label: 'Wallet',
      icon: <Wallet width={21} height={21} />,
      active: pathname === '/deposit',
      onClick: () => (user ? nav('/deposit') : onAuth('signin')),
    },
    {
      key: 'you',
      label: user ? 'You' : 'Sign in',
      icon: user ? <Avatar handle={user.handle} src={user.avatarUrl} size={24} /> : <Person width={22} height={22} />,
      active: ACCOUNT_PATHS.includes(pathname),
      onClick: () => (user ? nav('/profile') : onAuth('signin')),
    },
  ];

  return (
    <nav className="tabbar" aria-label="Primary">
      {tabs.map((t) => (
        <button key={t.key} className={`tabbar__item${t.active ? ' on' : ''}`} onClick={t.onClick} aria-current={t.active ? 'page' : undefined}>
          <span className="tabbar__ic">{t.icon}</span>
          <span className="tabbar__lbl">{t.label}</span>
        </button>
      ))}
    </nav>
  );
}
