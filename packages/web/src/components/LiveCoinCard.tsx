import { Link } from 'react-router-dom';
import Avatar from './Avatar';
import { Gift, Bolt } from '../icons';
import type { LiveCoin } from '../api';

/** A real linked-coin card in "Live right now" → links to the in-site watch page. */
export default function LiveCoinCard({ c }: { c: LiveCoin }) {
  const live = c.streamLive || c.hasAuction || c.hasGiveaway;
  const heading = c.title || c.prize || c.coinName || 'Live auctions';
  const short = `${c.coin.slice(0, 4)}…${c.coin.slice(-4)}`;
  return (
    <Link className="live-card" to={`/live/${c.coin}`}>
      <div className="live-card__thumb">
        {c.image ? <img src={c.image} alt="" loading="lazy" /> : <div className="live-card__ph"><Bolt width={30} height={30} /></div>}
        <div className="live-card__overlay" />
        <span className={`live-badge${live ? '' : ' off'}`} style={{ position: 'absolute', top: 12, left: 12 }}>
          {live ? <><span className="dot" /> LIVE</> : 'OFFLINE'}
        </span>
        {c.hasGiveaway && <span className="live-card__hot"><Gift width={12} height={12} style={{ verticalAlign: '-2px' }} /> Giveaway</span>}
        {c.currentBid && (
          <div className="live-card__bid">
            <span className="muted" style={{ fontSize: 11 }}>Current bid</span>
            <b>${c.currentBid}</b>
          </div>
        )}
      </div>
      <div className="live-card__meta">
        <div className="live-card__seller">
          <Avatar handle={c.sellerHandle} size={22} />
          <span>@{c.sellerHandle}</span>
        </div>
        <div className="live-card__title">{heading}</div>
        <div className="live-card__tags">
          <span className="pill" style={{ color: 'var(--accent-strong)', background: 'var(--accent-soft)' }}>pump.fun</span>
          <span className="pill">{short}</span>
        </div>
      </div>
    </Link>
  );
}
