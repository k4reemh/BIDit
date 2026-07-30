import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import Avatar from './Avatar';
import { ArrowRight, Shield, Truck, Wallet } from '../icons';

/**
 * Home hero, in three art directions.
 *
 * Hard layout rule for all three: the hero is a BAND, not a screen. It has to
 * finish inside ~64vh on a laptop so "Live right now" and the tops of the stream
 * cards are visible without scrolling. That constraint is what keeps the page
 * feeling like a marketplace rather than a brochure, so nothing here is allowed
 * to grow past `--hero-max`.
 *
 * Motion is dark-first and cheap: transform/opacity only, no layout animation,
 * and the global prefers-reduced-motion rule already flattens every loop.
 */

const CTA = ({ onAuth }: { onAuth: () => void }) => (
  <div className="hero__cta">
    <button className="btn btn-primary btn-lg" onClick={onAuth}>Start bidding</button>
    <Link className="btn btn-ghost btn-lg" to="/browse">Watch a live auction</Link>
  </div>
);

const Trust = () => (
  <div className="hero__trust">
    <span><Wallet width={14} height={14} /> Settles in USDC</span>
    <span><Shield width={14} height={14} /> Escrow on every order</span>
    <span><Truck width={14} height={14} /> Ships to your door</span>
  </div>
);

/** Words rise in one after another. Index drives the delay, so no JS timers. */
const Staged = ({ text, className = '' }: { text: string; className?: string }) => (
  <span className={className}>
    {/* The space is a SIBLING of the span, not inside it: an inline-block
        collapses its own trailing whitespace, which ran the words together. */}
    {text.split(' ').map((w, i) => (
      <span key={`${w}-${i}`}>
        <span className="hero__word" style={{ animationDelay: `${0.06 * i + 0.1}s` }}>{w}</span>{' '}
      </span>
    ))}
  </span>
);

/* ===========================================================================
   A. Live proof: a demo auction running beside the pitch.
   Scripted, not real: a real room would be empty at the worst moment, and this
   has to look identical for every visitor. Loops forever, no network, no data.
   ========================================================================= */
const DEMO_BIDS = [
  { handle: 'degen_max', amount: 34 },
  { handle: 'cardsbyleo', amount: 38 },
  { handle: 'holo_hunter', amount: 42 },
  { handle: 'you', amount: 46 },
];

function DemoAuction() {
  const [step, setStep] = useState(0);
  const [secs, setSecs] = useState(9);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    // One interval drives the whole loop: a bid lands, the clock resets a little,
    // and after the last bid it holds on the win before starting over.
    timer.current = setInterval(() => {
      setStep((s) => (s + 1) % (DEMO_BIDS.length + 1));
      setSecs(() => 6 + Math.floor(Math.random() * 4));
    }, 2200);
    return () => { if (timer.current) clearInterval(timer.current); };
  }, []);

  useEffect(() => {
    const t = setInterval(() => setSecs((s) => (s > 0 ? s - 1 : 0)), 1000);
    return () => clearInterval(t);
  }, []);

  const won = step === DEMO_BIDS.length;
  const shown = DEMO_BIDS.slice(0, Math.max(1, step + (won ? 0 : 1)));
  const top = shown[shown.length - 1]!;
  const fill = Math.max(0.06, Math.min(1, secs / 9));

  return (
    <div className={`hz-panel${won ? ' is-won' : ''}`} aria-hidden>
      <div className="hz-panel__glow" />
      <div className="hz-panel__head">
        <span className="hz-live"><span className="hz-live__dot" /> LIVE</span>
        <span className="hz-panel__seller">@cardsbyleo is streaming</span>
      </div>

      <div className="hz-panel__item">
        <img className="hz-panel__art" src="/categories/pokemon.jpg" alt="" loading="lazy" />
        <div className="hz-panel__meta">
          <b>Charizard, Base Set Holo</b>
          <span className="muted">Graded PSA 8</span>
        </div>
      </div>

      <div className="hz-panel__stats">
        <div><span>Current bid</span><b key={top.amount} className="hz-tick">${top.amount}</b></div>
        <div className="hz-panel__clock"><span>Ends in</span><b className={secs <= 3 ? 'low' : ''}>{secs}s</b></div>
      </div>
      <div className="hz-bar"><span className="hz-bar__fill" style={{ width: `${fill * 100}%` }} /></div>

      <div className="hz-feed">
        {shown.slice(-3).map((b) => (
          <div className="hz-feed__row" key={`${b.handle}-${b.amount}`}>
            <Avatar handle={b.handle} size={18} />
            <span className="hz-feed__who">{b.handle === 'you' ? 'You' : `@${b.handle}`}</span>
            <b>${b.amount}</b>
          </div>
        ))}
      </div>

      <div className={`hz-won${won ? ' show' : ''}`}>
        <span className="hz-won__pill">Sold to you at ${DEMO_BIDS[DEMO_BIDS.length - 1]!.amount}</span>
      </div>
    </div>
  );
}

export function HeroLiveProof({ onAuth }: { onAuth: () => void }) {
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
          <CTA onAuth={onAuth} />
          <Trust />
        </div>
        <div className="hero__stage"><DemoAuction /></div>
      </div>
    </section>
  );
}

/* ===========================================================================
   B. Atmospheric type: the words are the art. Lightest of the three.
   ========================================================================= */
export function HeroAtmospheric({ onAuth }: { onAuth: () => void }) {
  return (
    <section className="hero hero--atmos">
      <div className="hero__aura hero__aura--wide" aria-hidden />
      <div className="hero__beam" aria-hidden />
      <div className="hero__inner">
        <span className="hero__tag"><span className="dot" /> Live on Solana mainnet</span>
        <h1 className="display hero__title hero__title--xl">
          <Staged text="Live auctions," />
          <span className="hero__em"><Staged text="straight from the stream." /></span>
        </h1>
        <p className="hero__sub">
          Bid in USDC while the seller is on camera. Win at the buzzer and it ships to your door,
          escrowed the whole way.
        </p>
        <CTA onAuth={onAuth} />
        <Trust />
      </div>
    </section>
  );
}

/* ===========================================================================
   C. Collage: real category art drifting behind the words, with a light
   pointer parallax. Falls back to a still layout on touch and reduced motion.
   ========================================================================= */
const TILES = [
  { src: '/categories/pokemon.jpg', cls: 'a' },
  { src: '/categories/one-piece.jpg', cls: 'b' },
  { src: '/categories/sneakers.jpg', cls: 'c' },
  { src: '/categories/jewelry-watches.jpg', cls: 'd' },
  { src: '/categories/sports-cards.jpg', cls: 'e' },
];

export function HeroCollage({ onAuth }: { onAuth: () => void }) {
  const wrap = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    // Pointer parallax only: no scroll listener, no rAF loop when idle, and
    // skipped entirely for coarse pointers and reduced motion.
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    if (!window.matchMedia('(hover: hover) and (pointer: fine)').matches) return;
    let raf = 0;
    const onMove = (e: PointerEvent) => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const x = e.clientX / window.innerWidth - 0.5;
        const y = e.clientY / window.innerHeight - 0.5;
        el.style.setProperty('--px', String(x));
        el.style.setProperty('--py', String(y));
      });
    };
    window.addEventListener('pointermove', onMove, { passive: true });
    return () => { window.removeEventListener('pointermove', onMove); cancelAnimationFrame(raf); };
  }, []);

  return (
    <section className="hero hero--collage" ref={wrap}>
      <div className="hero__aura" aria-hidden />
      <div className="hero__tiles" aria-hidden>
        {TILES.map((t) => (
          <span className={`hero__tile hero__tile--${t.cls}`} key={t.cls}>
            <img src={t.src} alt="" loading="lazy" />
          </span>
        ))}
      </div>
      <div className="hero__inner hero__inner--over">
        <span className="hero__tag"><span className="dot" /> Live on Solana mainnet</span>
        <h1 className="display hero__title hero__title--xl">
          <Staged text="The cards are real." />
          <span className="hero__em"><Staged text="The bidding is live." /></span>
        </h1>
        <p className="hero__sub">
          Pokémon, One Piece, sneakers, watches. Sold live on stream, settled in USDC, shipped with
          escrow behind every order.
        </p>
        <CTA onAuth={onAuth} />
        <Trust />
      </div>
    </section>
  );
}

/** Temporary picker so all three can be compared in place: /?hero=a|b|c */
export default function Hero({ onAuth }: { onAuth: () => void }) {
  const which = new URLSearchParams(window.location.search).get('hero');
  if (which === 'b') return <HeroAtmospheric onAuth={onAuth} />;
  if (which === 'c') return <HeroCollage onAuth={onAuth} />;
  return <HeroLiveProof onAuth={onAuth} />;
}
