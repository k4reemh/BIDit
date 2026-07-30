import { Link } from 'react-router-dom';
import Avatar from './Avatar';
import { Gift, Eye, Verified } from '../icons';
import { countryFlag } from '../flag';
import { mediaSrc } from '../config';
import type { LiveCoin } from '../api';

/** A linked-coin card on the live grid → links to the in-site watch page. */
export default function LiveCoinCard({ c }: { c: LiveCoin }) {
  const live = c.streamLive || c.hasAuction || c.hasGiveaway;
  // A seller-set stream title wins over the coin name; the running item still
  // shows through when no custom title is set.
  const heading = c.streamTitle || c.title || c.prize || c.coinName || 'Live auctions';
  const flag = countryFlag(c.country);
  return (
    <Link className="live-card" to={`/live/${c.coin}`}>
      <div className="live-card__thumb">
        {c.image ? <img src={mediaSrc(c.image)} alt="" loading="lazy" /> : <div className="live-card__ph" />}
        <div className="live-card__overlay" />
        <div className="live-card__topline">
          <span className={`live-badge${live ? '' : ' off'}`}>
            {live ? <><span className="dot" /> LIVE</> : 'OFFLINE'}
          </span>
          {c.viewers > 0 && (
            <span className="live-card__viewers"><Eye width={13} height={13} /> {c.viewers.toLocaleString()}</span>
          )}
          {c.category && <span className="live-card__cat">{c.category}</span>}
        </div>
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
          <Avatar handle={c.sellerHandle} src={c.sellerAvatar} size={22} />
          <span>@{c.sellerHandle}</span>
          {c.verified && (
            <span className="vpill" title="Verified seller">
              <Verified width={11} height={11} /> Verified
            </span>
          )}
          {flag && <span className="live-card__flag" title={`Ships from ${flag.code}`}>{flag.flag}</span>}
        </div>
        <div className="live-card__title">{heading}</div>
      </div>
    </Link>
  );
}
