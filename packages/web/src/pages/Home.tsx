import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import LiveCoinCard from '../components/LiveCoinCard';
import { FEATURED_CATEGORIES } from '../data';
import { getLive, getPromo, type LiveCoin, type PromoState } from '../api';
import { ArrowRight, Bolt, Gift, Radio } from '../icons';

const HOW = [
  {
    n: '01',
    t: 'Bid live on stream',
    d: 'Auctions run right on the seller’s pump.fun stream. Place real USDC bids and watch the price move with the room.',
  },
  {
    n: '02',
    t: 'Win at the buzzer',
    d: 'Highest bid when the clock runs out takes it. Anti-snipe extends the timer on late bids, so nobody steals it at 0:01.',
  },
  {
    n: '03',
    t: 'It ships to your door',
    d: 'Your money sits in escrow until the item arrives. The seller ships, you confirm, everyone gets paid.',
  },
];

export default function Home({ onAuth }: { onAuth: () => void }) {
  const [live, setLive] = useState<LiveCoin[] | null>(null);
  const [promo, setPromo] = useState<PromoState | null>(null);
  useEffect(() => {
    getLive().then(setLive).catch(() => setLive([]));
    getPromo().then(setPromo).catch(() => setPromo(null));
  }, []);

  // Home is a shelf, not the catalog: the 8 most interesting streams, rest on /browse.
  const streams = live ? [...new Map(live.map((c) => [c.coin, c])).values()].slice(0, 8) : null;

  return (
    <main>
      {/* ---- hero ---- */}
      <section className="hero">
        <div className="hero__inner risein">
          <span className="hero__tag"><span className="dot" /> Live in beta</span>
          <h1 className="display hero__title">Bid it. Win it. Ship it.</h1>
          <p className="hero__sub">
            BIDit turns pump.fun streams into live auctions. Pok&eacute;mon, One Piece, sports cards, tech,
            anything. Bid in USDC, win at the buzzer, and it ships straight to your door with buyer
            protection on every order.
          </p>
          <div className="hero__cta">
            <button className="btn btn-primary btn-lg" onClick={onAuth}>Start bidding</button>
            <Link className="btn btn-ghost btn-lg" to="/browse">Watch live auctions</Link>
          </div>
          <div className="hero__trust">
            <span>Settles in USDC</span><span className="d" />
            <span>Built on Solana</span><span className="d" />
            <span>4% of sales buy back $BID</span>
          </div>
        </div>
      </section>

      {/* ---- launch seller promo ---- */}
      {promo?.active && (
        <section className="container promo-wrap">
          <a href="/sell" className="promo-band">
            <span className="promo-band__badge"><Bolt width={13} height={13} /> Launch offer · first 3 days</span>
            <div className="promo-band__body">
              <b className="promo-band__title">Start selling on BIDit, earn a ${promo.bonusUsd} USDC bonus</b>
              <span className="promo-band__sub">
                Become a seller and fulfill <b>${promo.thresholdUsd}</b> of orders. We match it with <b>${promo.bonusUsd} USDC</b> paid straight to your wallet.
              </span>
            </div>
            <span className="promo-band__cta">Start selling <ArrowRight width={18} height={18} /></span>
          </a>
        </section>
      )}

      {/* ---- live now ---- */}
      <section id="featured" className="section container">
        <div className="section__head">
          <div>
            <h2 className="section-title">Live right now</h2>
            <div className="section-sub">Real auctions on real streams. Tap in and bid.</div>
          </div>
          <Link className="section__all" to="/browse">Browse all <ArrowRight width={16} height={16} /></Link>
        </div>
        {streams === null ? (
          <div className="live-grid">
            {Array.from({ length: 4 }, (_, i) => (
              <div key={i} className="live-skel" aria-hidden />
            ))}
          </div>
        ) : streams.length > 0 ? (
          <div className="live-grid">
            {streams.map((c) => <LiveCoinCard key={c.coin} c={c} />)}
          </div>
        ) : (
          <div className="home-quiet">
            <span className="home-quiet__ic"><Radio width={24} height={24} /></span>
            <div className="home-quiet__body">
              <b>Nobody&rsquo;s live at this exact moment.</b>
              <p className="muted">Sellers go live throughout the day. Follow <a href="https://x.com/biditsol" target="_blank" rel="noreferrer">@biditsol</a> to catch the next stream, or start your own.</p>
            </div>
            <Link className="btn btn-ghost" to="/sell">Go live yourself</Link>
          </div>
        )}
      </section>

      {/* ---- categories ---- */}
      <section className="section container">
        <div className="section__head"><h2 className="section-title">Shop by category</h2></div>
        <div className="cat-grid">
          {FEATURED_CATEGORIES.map((c) => (
            <Link className="cat" to={`/browse?cat=${encodeURIComponent(c.name)}`} key={c.name}>
              <img className="cat__img" src={c.image} alt="" loading="lazy" />
              <span className="cat__grad" />
              <span className="cat__name">{c.name}</span>
            </Link>
          ))}
          <Link className="cat cat--more" to="/browse">
            <span className="cat__more-icon"><ArrowRight width={18} height={18} /></span>
            <span className="cat__more-title">Browse more</span>
            <span className="cat__more-sub">All categories</span>
          </Link>
        </div>
      </section>

      {/* ---- how it works ---- */}
      <section className="section container">
        <div className="section__head">
          <div>
            <h2 className="section-title">How BIDit works</h2>
          </div>
        </div>
        <div className="how">
          {HOW.map((s) => (
            <div className="how__step" key={s.n}>
              <span className="how__num">{s.n}</span>
              <h3>{s.t}</h3>
              <p>{s.d}</p>
            </div>
          ))}
        </div>
      </section>

      {/* ---- BIDit Points ---- */}
      <section className="section container">
        <div className="pts-band on-navy">
          <div className="pts-band__glow" aria-hidden />
          <div className="pts-band__body">
            <span className="pts-band__eyebrow"><Gift width={14} height={14} /> BIDit Points · Community airdrops</span>
            <h2 className="display pts-band__title">Every bid earns a bigger slice of the airdrop.</h2>
            <p className="pts-band__sub">
              Earn <b>100 points per $1</b> you spend and <b>20 per $1</b> you sell, with bonus drops for your
              first bid and first win. <b>5% of $BID supply</b> is locked for community airdrops. Your points
              decide your share.
            </p>
            <div className="pts-band__cta">
              <Link className="btn btn-primary btn-lg" to="/points">Start earning points <ArrowRight width={17} height={17} /></Link>
              <Link className="btn btn-ghost btn-lg" to="/leaderboard">View leaderboard</Link>
            </div>
          </div>
          <div className="pts-band__chips" aria-hidden>
            <div className="pts-band__chip"><b>+100 pts</b><span>per $1 spent</span></div>
            <div className="pts-band__chip"><b>+3,000 pts</b><span>win your first auction</span></div>
            <div className="pts-band__chip"><b>+20 pts</b><span>per $1 sold</span></div>
            <div className="pts-band__chip pts-band__chip--hot"><b>Airdrop #1</b><span>1 month after launch</span></div>
          </div>
        </div>
      </section>

      {/* ---- seller CTA ---- */}
      <section className="section container">
        <div className="cta-band on-navy">
          <div>
            <h2 className="display cta-band__title">Turn your stream into an auction house.</h2>
            <p>List your cards, run live auctions and wheel spins, and get paid in USDC. Setup takes about five minutes.</p>
          </div>
          <Link className="btn btn-accent btn-lg" to="/sell">Become a seller <ArrowRight width={18} height={18} /></Link>
        </div>
      </section>
    </main>
  );
}
