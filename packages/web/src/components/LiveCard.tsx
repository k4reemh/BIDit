import Avatar from './Avatar';
import { Eye } from '../icons';
import type { LiveAuction } from '../data';

export default function LiveCard({ a }: { a: LiveAuction }) {
  return (
    <a className="live-card" href="#">
      <div className="live-card__thumb">
        <img src={a.image} alt="" loading="lazy" />
        <div className="live-card__overlay" />
        <span className="live-badge" style={{ position: 'absolute', top: 12, left: 12 }}>
          <span className="dot" /> LIVE
        </span>
        <span className="live-card__viewers">
          <Eye width={13} height={13} /> {a.viewers.toLocaleString()}
        </span>
        {a.hot && <span className="live-card__hot">🔥 Hot</span>}
        <div className="live-card__bid">
          <span className="muted" style={{ fontSize: 11 }}>Current bid</span>
          <b>${a.currentBid}</b>
        </div>
      </div>
      <div className="live-card__meta">
        <div className="live-card__seller">
          <Avatar handle={a.seller} size={22} hue={a.avatarHue} />
          <span>{a.seller}</span>
        </div>
        <div className="live-card__title">{a.title}</div>
        <div className="live-card__tags">
          <span className="pill" style={{ color: 'var(--cyan)', borderColor: 'rgba(54,200,255,0.25)' }}>{a.category}</span>
          <span className="pill">{a.tag}</span>
        </div>
      </div>
    </a>
  );
}
