import { useEffect, useState } from 'react';
import LiveCard from '../components/LiveCard';
import LiveCoinCard from '../components/LiveCoinCard';
import { FEATURED, CATEGORIES } from '../data';
import { getLive, type LiveCoin } from '../api';
import { ArrowRight, Bolt, Truck, Wallet } from '../icons';

export default function Home({ onAuth }: { onAuth: () => void }) {
  const [live, setLive] = useState<LiveCoin[] | null>(null);
  useEffect(() => {
    getLive().then(setLive).catch(() => setLive([]));
  }, []);
  return (
    <main>
      {/* ---- hero ---- */}
      <section className="hero">
        <div className="hero__inner risein">
          <span className="hero__tag"><span className="dot" /> Now live in beta</span>
          <h1 className="display hero__title">The live crypto marketplace for bidding on Anything, Anytime, Anywhere.</h1>
          <p className="hero__sub">
            Bid in real time on Pokémon, One Piece, Clothes, Tech, Bounties, Anything, directly on pump.fun.{' '}
            <b>Bid it, Win it, Ship it.</b> Buyer protection guaranteed.
          </p>
          <div className="hero__cta">
            <button className="btn btn-primary btn-lg" onClick={onAuth}>Start bidding — it's free</button>
            <a className="btn btn-ghost btn-lg" href="#featured">Browse live auctions</a>
          </div>
          <div className="hero__trust">
            <span>Settles in USDC</span><span className="d" />
            <span>Built on Solana</span><span className="d" />
            <span>4% of sales buy back $BID</span>
          </div>
        </div>
      </section>

      {/* ---- featured live ---- */}
      <section id="featured" className="section container">
        <div className="section__head">
          <div>
            <h2 className="section-title">Live right now</h2>
            <div className="section-sub">Watch the stream and bid — right here, no extension needed.</div>
          </div>
          <a className="section__all" href="#">Browse all <ArrowRight width={16} height={16} /></a>
        </div>
        <div className="live-grid">
          {live && live.length > 0
            ? [...new Map(live.map((c) => [c.coin, c])).values()].map((c) => <LiveCoinCard key={c.coin} c={c} />)
            : FEATURED.map((a) => <LiveCard key={a.id} a={a} />)}
        </div>
      </section>

      {/* ---- categories ---- */}
      <section className="section container">
        <div className="section__head"><h2 className="section-title">Shop by category</h2></div>
        <div className="cat-grid">
          {CATEGORIES.map((c) => (
            <a className="cat" href="#" key={c.name}>
              <span className="cat__glyph" style={{ background: c.soft, color: c.ink }}>{c.glyph}</span>
              <span className="cat__name">{c.name}</span>
              <ArrowRight className="cat__arrow" width={16} height={16} />
            </a>
          ))}
        </div>
      </section>

      {/* ---- how it works ---- */}
      <section className="section container">
        <div className="section__head">
          <div>
            <h2 className="section-title">How BIDit works</h2>
            <div className="section-sub">Bid live, win, and we handle the rest.</div>
          </div>
        </div>
        <div className="how">
          {[
            { ic: Bolt, t: 'Bid live on stream', d: 'Place real USDC bids during the break. Anti-snipe keeps every auction fair to the buzzer.' },
            { ic: Truck, t: 'Win it, we ship it', d: 'Your funds sit in escrow until the seller ships and the item lands in your hands.' },
            { ic: Wallet, t: '4% buys back $BID', d: <>Every shipped sale routes <b>4%</b> to the $BID buyback and <b>1%</b> to a buyer-protection treasury — the more items move, the more it pumps.</> },
          ].map((s) => (
            <div className="how__step" key={s.t}>
              <span className="how__ic"><s.ic width={22} height={22} /></span>
              <h3>{s.t}</h3>
              <p>{s.d}</p>
            </div>
          ))}
        </div>
      </section>

      {/* ---- seller CTA ---- */}
      <section className="section container">
        <div className="cta-band">
          <div>
            <h2 className="display cta-band__title">Turn your stream into an auction house.</h2>
            <p>List cards, run live auctions and wheel spins, and get paid in USDC. Setup takes minutes.</p>
          </div>
          <a className="btn btn-accent btn-lg" href="/sell">Become a seller <ArrowRight width={18} height={18} /></a>
        </div>
      </section>
    </main>
  );
}
