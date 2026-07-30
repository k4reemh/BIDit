import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Shield, Truck, Wallet } from '../icons';

/**
 * Home hero.
 *
 * Hard layout rule: the hero is a BAND, not a screen. It finishes inside ~64vh
 * on a laptop so "Live right now" and the tops of the stream cards stay visible
 * without scrolling, which is what keeps the page reading as a live marketplace
 * rather than a brochure.
 *
 * Motion is dark-first and cheap: transform and opacity only, no layout
 * animation, and the global prefers-reduced-motion rule flattens every loop.
 */

/** Words rise one after another. Index drives the delay, so no JS timers. */
const Staged = ({ text }: { text: string }) => (
  <>
    {/* The space is a SIBLING of the span, not inside it: an inline-block
        collapses its own trailing whitespace, which ran the words together. */}
    {text.split(' ').map((w, i) => (
      <span key={`${w}-${i}`}>
        <span className="hero__word" style={{ animationDelay: `${0.06 * i + 0.1}s` }}>{w}</span>{' '}
      </span>
    ))}
  </>
);

/* ---------------------------------------------------------------------------
   The demo auction.

   Scripted on a single clock rather than driven by real data: a real room would
   be empty at the worst possible moment, and this has to look identical for
   every visitor. One interval advances `t`; everything else is derived from it,
   so the loop can never drift out of sync with itself.

   The beats are the real ones, in the real order: rival bids climb, YOU take it
   late, anti-snipe springs the clock back (which is the honest reason sniping
   does not work here), nobody answers, and it sells AT ZERO. The old version
   declared a winner with time still on the clock, which is not how any auction
   on the platform actually behaves.
--------------------------------------------------------------------------- */
type Bid = { at: number; who: string; name: string; amount: number; pfp?: string };

const START_CLOCK = 8;
/** When YOU bid. Anti-snipe pushes the clock back to EXTEND_TO from here. */
const YOU_AT = 5.2;
const EXTEND_TO = 5;
const SOLD_AT = YOU_AT + EXTEND_TO; // 10.2s: the clock genuinely reaches zero
const LOOP = SOLD_AT + 4.2; // hold on the win, then run it again

const BIDS: Bid[] = [
  { at: 0.5, who: 'toly', name: '@toly', amount: 34, pfp: '/demo/toly.jpg' },
  { at: 1.7, who: 'alon', name: '@alon', amount: 38, pfp: '/demo/alon.jpg' },
  { at: 2.9, who: 'cz', name: '@cz', amount: 42, pfp: '/demo/cz.jpg' },
  { at: 4.0, who: 'ansem', name: '@ansem', amount: 46, pfp: '/demo/ansem.jpg' },
  { at: YOU_AT, who: 'you', name: 'You', amount: 52 },
];

function DemoAuction() {
  const [t, setT] = useState(0);

  useEffect(() => {
    const STEP = 0.1;
    const id = setInterval(() => setT((prev) => (prev + STEP >= LOOP ? 0 : prev + STEP)), STEP * 1000);
    return () => clearInterval(id);
  }, []);

  const placed = BIDS.filter((b) => b.at <= t);
  const top = placed[placed.length - 1];
  const youLead = top?.who === 'you';
  // Before YOU bid the clock is winding down from START_CLOCK; after, anti-snipe
  // has reset it to EXTEND_TO and it runs from there to zero.
  const clock = t < YOU_AT ? START_CLOCK - t : EXTEND_TO - (t - YOU_AT);
  const secs = Math.max(0, clock);
  const sold = t >= SOLD_AT;
  const extending = t >= YOU_AT && t < YOU_AT + 1.6;
  const low = !sold && secs <= 3;
  const fill = Math.max(0, Math.min(1, secs / (t < YOU_AT ? START_CLOCK : EXTEND_TO)));

  return (
    <div className={`hz${sold ? ' is-sold' : ''}${low ? ' is-low' : ''}`} aria-hidden>
      <div className="hz__glow" />

      <div className="hz__head">
        <span className="hz__live"><span className="hz__livedot" /> LIVE</span>
        <span className="hz__seller">@cardsbyleo is streaming</span>
        <span className="hz__viewers">1,204 watching</span>
      </div>

      <div className="hz__item">
        <img className="hz__art" src="/demo/charizard.png" alt="" loading="lazy" width="52" height="72" />
        <div className="hz__meta">
          <b>Charizard, Base Set Holo</b>
          <span>1st Edition &middot; PSA 8</span>
        </div>
      </div>

      <div className="hz__stats">
        <div className="hz__price">
          <span>Current bid</span>
          <b key={top?.amount ?? 0} className="hz__amount">${top?.amount ?? 30}</b>
        </div>
        <div className="hz__clockwrap">
          <span>{sold ? 'Closed' : 'Ends in'}</span>
          <b className={`hz__clock${low ? ' beat' : ''}`}>{sold ? '0.0s' : `${secs.toFixed(1)}s`}</b>
        </div>
      </div>

      <div className="hz__barwrap">
        <div className="hz__bar"><span className="hz__fill" style={{ width: `${fill * 100}%` }} /></div>
        {extending && <span className="hz__ext">+5s, clock extended</span>}
      </div>

      <div className="hz__feed">
        {placed.slice(-3).map((b) => (
          <div className={`hz__row${b.who === 'you' ? ' is-you' : ''}`} key={`${b.who}-${b.amount}`}>
            {b.pfp
              ? <img className="hz__pfp" src={b.pfp} alt="" loading="lazy" width="20" height="20" />
              : <span className="hz__pfp hz__pfp--you">Y</span>}
            <span className="hz__who">{b.name}</span>
            <b>${b.amount}</b>
          </div>
        ))}
      </div>

      <div className="hz__status">
        {youLead && !sold && <span className="hz__lead">You&rsquo;re the top bid</span>}
      </div>

      {/* The win. Only ever fires once the clock has actually reached zero. */}
      <div className={`hz__won${sold ? ' show' : ''}`}>
        <div className="hz__woncard">
          <span className="hz__wonkick">Sold</span>
          <b className="hz__wontitle">You won it</b>
          <span className="hz__wonsub">Charizard, Base Set Holo for $52</span>
        </div>
      </div>
    </div>
  );
}

export default function Hero({ onAuth }: { onAuth: () => void }) {
  return (
    <section className="hero hero--split">
      <div className="hero__aura" aria-hidden />
      <div className="hero__grid container">
        <div className="hero__copy">
          <span className="hero__tag"><span className="dot" /> Live on Solana mainnet</span>
          <h1 className="display hero__title hero__title--left">
            <Staged text="Every stream is an" />
            <span className="hero__em"><Staged text="auction house." /></span>
          </h1>
          <p className="hero__sub hero__sub--left">
            Sellers go live on pump.fun. You bid in USDC as it happens, win at the buzzer, and it
            ships to your door with your money held in escrow until it lands.
          </p>
          <div className="hero__cta">
            <button className="btn btn-primary btn-lg" onClick={onAuth}>Start bidding</button>
            <Link className="btn btn-ghost btn-lg" to="/browse">Watch a live auction</Link>
          </div>
          <div className="hero__trust">
            <span><Wallet width={14} height={14} /> Settles in USDC</span>
            <span><Shield width={14} height={14} /> Escrow on every order</span>
            <span><Truck width={14} height={14} /> Ships to your door</span>
          </div>
        </div>
        <div className="hero__stage"><DemoAuction /></div>
      </div>
    </section>
  );
}
