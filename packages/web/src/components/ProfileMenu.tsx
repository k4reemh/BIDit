import { Link } from 'react-router-dom';
import Avatar from './Avatar';
import type { User } from '../App';
import {
  Gift, UserCheck, Truck, Bookmark, Bolt, Bag, Shield,
  Wallet, Users, Settings, Info, Logout, Chevron,
} from '../icons';

const TILES = [
  { icon: Gift, label: 'Refer Friends', to: '/refer' },
  { icon: UserCheck, label: 'Become a Seller', to: '/sell' },
  { icon: Truck, label: 'Payments & Shipping', to: '/shipping' },
  { icon: Bookmark, label: 'Saved', to: '/saved' },
  { icon: Bolt, label: 'Bids & Offers', to: '/bids' },
  { icon: Bag, label: 'Purchases', to: '/purchases' },
  { icon: Shield, label: 'Account Health', to: '/account-health' },
];

export default function ProfileMenu({
  user,
  onClose,
  onLogout,
}: {
  user: User;
  onClose: () => void;
  onLogout: () => void;
}) {
  return (
    <>
      <div className="pm__backdrop" onClick={onClose} />
      <div className="pm card" role="menu">
        <Link to="/profile" className="pm__header" onClick={onClose}>
          <Avatar handle={user.handle} src={user.avatarUrl} size={52} />
          <div className="pm__id">
            <b>{user.handle}</b>
            <span className="muted">
              <b style={{ color: 'var(--ink)' }}>{user.following}</b> Following&nbsp;&nbsp;·&nbsp;&nbsp;
              <b style={{ color: 'var(--ink)' }}>{user.followers}</b> Follower{user.followers === 1 ? '' : 's'}
            </span>
          </div>
          <Chevron width={18} height={18} style={{ transform: 'rotate(-90deg)', color: 'var(--faint)' }} />
        </Link>

        <div className="pm__grid">
          {TILES.map((t) => (
            <Link key={t.label} to={t.to} className="pm__tile" onClick={onClose}>
              <t.icon width={22} height={22} />
              <span>{t.label}</span>
            </Link>
          ))}
          <Link to="/deposit" className="pm__tile pm__tile--accent" onClick={onClose}>
            <Wallet width={22} height={22} />
            <span>Deposit</span>
            <em className="pm__soon">USDC</em>
          </Link>
        </div>

        <div className="pm__rows">
          <Link to="/friends" className="pm__row" onClick={onClose}><Users width={20} height={20} /> Friends <Chevron className="pm__chev" width={16} height={16} /></Link>
          <Link to="/settings" className="pm__row" onClick={onClose}><Settings width={20} height={20} /> Account Settings <Chevron className="pm__chev" width={16} height={16} /></Link>
          <Link to="/help" className="pm__row" onClick={onClose}><Info width={20} height={20} /> Help &amp; Legal <Chevron className="pm__chev" width={16} height={16} /></Link>
          <button className="pm__row pm__row--logout" onClick={() => { onLogout(); onClose(); }}>
            <Logout width={20} height={20} /> Log out
          </button>
        </div>
      </div>
    </>
  );
}
