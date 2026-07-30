import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import Avatar from './Avatar';
import BidSparks from './BidSparks';
import { runConfetti, CONFETTI } from '../lib/confetti';
import { Radio, Wallet, Check, Bag, Truck, Lock, Shield, ArrowRight } from '../icons';

/**
 * First-run interactive tutorial. A guided, "learn by doing" tour of the whole
 * buyer loop shown once after signup. Every scene is a self-contained, fully
 * simulated mini-demo (no API calls, no real money): the user funds a wallet,
 * places a bid, feels anti-snipe extend the clock, rides the countdown to zero
 * and wins on the spot, ships it, buys now, and sees why escrow makes it all
 * risk free. Reuses the real bid bar, sparks, and confetti so it looks like the
 * product, not a cartoon.
 */
const SCENES = 6;
const TUTORIAL_SEEN_KEY = 'bidit_tutorial_seen';

const CARD_IMG = 'https://images.pokemontcg.io/base1/4_hires.png';
const PACK_IMG = 'https://images.pokemontcg.io/base1/16_hires.png';

export function markTutorialSeen() {
  try { localStorage.setItem(TUTORIAL_SEEN_KEY, '1'); } catch { /* ignore */ }
}
export function hasSeenTutorial(): boolean {
  try { return localStorage.getItem(TUTORIAL_SEEN_KEY) === '1'; } catch { return false; }
}

export default function Tutorial({ onDone }: { onDone: () => void }) {
  const [step, setStep] = useState(0);
  const next = () => setStep((s) => Math.min(SCENES - 1, s + 1));
  const back = () => setStep((s) => Math.max(0, s - 1));
  const finish = () => { markTutorialSeen(); onDone(); };

  return createPortal(
    <div className="tut" role="dialog" aria-modal="true" aria-label="How BIDit works">
      <div className="tut__inner">
        <div className="tut__top">
          <div className="tut__dots" aria-hidden>
            {Array.from({ length: SCENES }).map((_, i) => (
              <span key={i} className={`tut__dot${i === step ? ' on' : ''}${i < step ? ' done' : ''}`} />
            ))}
          </div>
          <button className="tut__skip" onClick={finish}>Skip</button>
        </div>

        <div className="tut__body">
          {step === 0 && <SceneWelcome onNext={next} />}
          {step === 1 && <SceneFund onNext={next} />}
          {step === 2 && <SceneBid onNext={next} />}
          {step === 3 && <SceneReadyShip onNext={next} />}
          {step === 4 && <SceneBuy onNext={next} />}
          {step === 5 && <SceneEscrow onFinish={finish} />}
        </div>

        <div className="tut__foot">
          {step > 0 && (
            <button className="tut__back" onClick={back}><ArrowRight width={15} height={15} style={{ transform: 'rotate(180deg)' }} /> Back</button>
          )}
          <span className="tut__count">{step + 1} / {SCENES}</span>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/* ---- scene shell ---------------------------------------------------------- */
function Scene({ icon, kicker, title, sub, children }: { icon: React.ReactNode; kicker: string; title: string; sub: string; children?: React.ReactNode }) {
  return (
    <div className="tut-scene">
      <div className="tut-scene__ic">{icon}</div>
      <div className="tut-scene__kick">{kicker}</div>
      <h2 className="tut-scene__title">{title}</h2>
      <p className="tut-scene__sub">{sub}</p>
      {children}
    </div>
  );
}

/* ---- 1 · welcome ---------------------------------------------------------- */
function SceneWelcome({ onNext }: { onNext: () => void }) {
  return (
    <div className="tut-scene tut-scene--welcome">
      <h2 className="tut-scene__title">Welcome to BIDit</h2>
      <p className="tut-scene__sub">Here's the whole thing in about a minute: bid live, win the card, the seller ships it to you. Let's try it.</p>
      <button className="btn btn-primary btn-lg tut-cta" onClick={onNext}>Show me how <ArrowRight width={17} height={17} /></button>
    </div>
  );
}

/* ---- 2 · fund ------------------------------------------------------------- */
function SceneFund({ onNext }: { onNext: () => void }) {
  const [bal, setBal] = useState(0);
  const [funded, setFunded] = useState(false);

  const add = () => {
    if (funded) return;
    setFunded(true);
    const start = performance.now();
    const dur = 900;
    const tick = (t: number) => {
      const p = Math.min(1, (t - start) / dur);
      const eased = 1 - Math.pow(1 - p, 3);
      setBal(Math.round(eased * 50 * 100) / 100);
      if (p < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  };

  return (
    <Scene
      icon={<Wallet width={26} height={26} />}
      kicker="Step 1 · your wallet"
      title="Fund your balance"
      sub="Add USDC once. It sits in your balance, untouched until you win a bid."
    >
      <div className={`tut-wallet${funded ? ' funded' : ''}`}>
        <span className="tut-wallet__label">Balance</span>
        <span className="tut-wallet__amt">${bal.toFixed(2)}</span>
        <span className="tut-wallet__usdc">USDC</span>
      </div>
      {!funded ? (
        <button className="btn btn-primary btn-lg tut-cta" onClick={add}>Add $50 USDC</button>
      ) : (
        <>
          <p className="tut-note"><Check width={15} height={15} /> Funded. Bids just reserve your money. It only leaves when you win.</p>
          <button className="btn btn-primary btn-lg tut-cta" onClick={onNext}>Next <ArrowRight width={17} height={17} /></button>
        </>
      )}
    </Scene>
  );
}

/* ---- 3 · bid, ride the clock to zero, win --------------------------------- */
const BID_MAX = 8;
// After the demo bid the clock ticks a little faster than real time, so the
// win lands in ~3.5s instead of a full 8s wait.
const COUNTDOWN_SPEED = 2.2;
function SceneBid({ onNext }: { onNext: () => void }) {
  const [remaining, setRemaining] = useState(3.4);
  const [bidded, setBidded] = useState(false);
  const [won, setWon] = useState(false);
  const [spark, setSpark] = useState(false);
  const [extend, setExtend] = useState(false);
  const biddedRef = useRef(false);
  const wonRef = useRef(false);
  const last = useRef(0);

  useEffect(() => {
    let raf = 0;
    const loop = (t: number) => {
      if (!last.current) last.current = t;
      const dt = Math.min(0.05, (t - last.current) / 1000);
      last.current = t;
      setRemaining((r) => {
        if (biddedRef.current) {
          // Post-bid: run the extended clock all the way down to zero...
          const nr = Math.max(0, r - dt * COUNTDOWN_SPEED);
          if (nr === 0 && !wonRef.current) {
            // ...and the moment it hits zero, they win.
            wonRef.current = true;
            setWon(true);
          }
          return nr;
        }
        // Before the user bids, hold near zero and keep nudging. Never actually
        // expire, so they always get to feel the tap → extend moment.
        let nr = r - dt;
        if (nr < 0.6) nr = 0.6;
        return Math.max(0, nr);
      });
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  const placeBid = () => {
    if (biddedRef.current) return;
    biddedRef.current = true;
    setBidded(true);
    setSpark(true);
    setExtend(true);
    setRemaining(BID_MAX); // anti-snipe: the clock springs back
    setTimeout(() => setSpark(false), 1300);
    setTimeout(() => setExtend(false), 2600);
  };

  const fill = Math.max(0, Math.min(1, remaining / BID_MAX));
  const low = fill < 0.4;

  return (
    <>
      <Scene
        icon={<Radio width={26} height={26} />}
        kicker="Step 2 · bid live"
        title="Place a bid"
        sub={bidded
          ? 'See that? Your late bid pushed the clock back to 8s. That’s anti-snipe. Now hold it to zero and it’s yours.'
          : 'Tap Bid before the timer hits zero. A late bid extends the clock, so bidding stays fair.'}
      >
        <div className="tut-bid">
          <div className="tut-bid__head">
            <img className="tut-bid__thumb" src={CARD_IMG} alt="" />
            <div className="tut-bid__id">
              <span className="live-badge"><span className="dot" /> LIVE</span>
              <div className="tut-bid__title">Charizard · Base Set Holo</div>
            </div>
          </div>
          <div className="tut-bid__stats">
            <div><span>Current bid</span><b>${bidded ? '12' : '8'}</b></div>
            <div className="tut-bid__timer"><span>Ends in</span><b className={low ? 'low' : ''}>{remaining.toFixed(1)}s</b></div>
          </div>
          <div className="bp__barwrap">
            <div className="bp__bar"><div className={`bp__fill${low ? ' low' : ''}`} style={{ width: `${fill * 100}%` }} /></div>
            <BidSparks fill={fill} active={spark || low} />
          </div>
          <div className="tut-bid__leader">
            {bidded
              ? <><Avatar handle="you" size={20} /> <b>You're the top bid</b> · $12</>
              : <><Avatar handle="degen_max" size={20} /> @degen_max leading · min next $12</>}
          </div>
          {extend && <div className="tut-bid__extend">+5s · clock extended</div>}
        </div>

        {!bidded ? (
          <button className="btn btn-accent btn-lg tut-cta tut-cta--pulse" onClick={placeBid}>Bid $12</button>
        ) : (
          <p className="tut-note tut-note--muted">Nobody outbids you before zero and it's yours...</p>
        )}
      </Scene>
      {won && <WinPop onNext={onNext} />}
    </>
  );
}

/** The "You won" moment, popped over the bid scene the instant the clock dies. */
function WinPop({ onNext }: { onNext: () => void }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    runConfetti(canvas.current, CONFETTI, 170, 4200);
  }, []);
  return (
    <div className="tut-winpop">
      <canvas ref={canvas} className="tut-win__confetti" />
      <div className="tut-win__av"><Avatar handle="you" size={70} /></div>
      <div className="tut-scene__kick">You won</div>
      <h2 className="tut-scene__title tut-win__head">It's yours!</h2>
      <div className="tut-win__item">
        <img src={CARD_IMG} alt="" />
        <span>Charizard · Base Set Holo</span>
      </div>
      <div className="tut-win__price">$12</div>
      <p className="tut-scene__sub">The sale settles instantly in USDC, and a slice of every sale buys back <b>$BID</b>.</p>
      <button className="btn btn-primary btn-lg tut-cta" onClick={onNext}>Continue <ArrowRight width={17} height={17} /></button>
    </div>
  );
}

/* ---- 4 · ready to ship (win fulfillment + buy-now-pay-later) --------------- */
function SceneReadyShip({ onNext }: { onNext: () => void }) {
  const [shipped, setShipped] = useState(false);
  // Paying shipping IS completing this step; move on without an extra Next tap.
  useEffect(() => {
    if (!shipped) return;
    const t = setTimeout(onNext, 1400);
    return () => clearTimeout(t);
  }, [shipped, onNext]);
  return (
    <Scene
      icon={<Truck width={26} height={26} />}
      kicker="Step 3 · shipping"
      title="Ready to ship"
      sub="Your wins collect in Ready to ship. Send one whenever you like for a flat fee. The seller packs it and ships it to you."
    >
      <div className={`tut-buy${shipped ? ' bought' : ''}`}>
        <img className="tut-buy__thumb" src={CARD_IMG} alt="" />
        <div className="tut-buy__info">
          <div className="tut-buy__title">Charizard · Base Set Holo</div>
          <div className="tut-buy__won">Won · $12</div>
        </div>
        {shipped
          ? <span className="tut-buy__done"><Check width={16} height={16} /> On its way</span>
          : <button className="btn btn-primary btn-sm tut-buy__btn" onClick={() => setShipped(true)}>Ship now · $5</button>}
      </div>
      <div className="tut-tip">
        <span className="tut-tip__ic"><Bag width={16} height={16} /></span>
        <span><b>Skip shipping costs with Buy Now, Pay Later.</b> Sellers store your items until you're ready to ship.</span>
      </div>
      {!shipped
        ? <p className="tut-note tut-note--muted">Tap <b>Ship now</b> to send your win.</p>
        : <p className="tut-note"><Check width={15} height={15} /> Paid. The seller gets your label and packs it up.</p>}
    </Scene>
  );
}

/* ---- 5 · buy now ---------------------------------------------------------- */
function SceneBuy({ onNext }: { onNext: () => void }) {
  const [bought, setBought] = useState(false);
  // Buying completes the step; no extra Next tap.
  useEffect(() => {
    if (!bought) return;
    const t = setTimeout(onNext, 1400);
    return () => clearTimeout(t);
  }, [bought, onNext]);
  return (
    <Scene
      icon={<Bag width={26} height={26} />}
      kicker="Step 4 · buy now"
      title="Or skip the wait"
      sub="Not everything is an auction. Sellers list items in their shop you can buy instantly at a set price."
    >
      <div className={`tut-buy${bought ? ' bought' : ''}`}>
        <img className="tut-buy__thumb" src={PACK_IMG} alt="" />
        <div className="tut-buy__info">
          <div className="tut-buy__title">OP-09 Booster Pack</div>
          <div className="tut-buy__price">$30</div>
        </div>
        {bought
          ? <span className="tut-buy__done"><Check width={16} height={16} /> Bought</span>
          : <button className="btn btn-primary btn-sm tut-buy__btn" onClick={() => setBought(true)}>Buy now</button>}
      </div>
      {!bought
        ? <p className="tut-note tut-note--muted">Tap <b>Buy now</b> to grab it.</p>
        : <p className="tut-note"><Check width={15} height={15} /> Done. It goes straight to shipping, just like a win.</p>}
    </Scene>
  );
}

/* ---- 6 · escrow (finale) --------------------------------------------------- */
function SceneEscrow({ onFinish }: { onFinish: () => void }) {
  return (
    <Scene
      icon={<Shield width={26} height={26} />}
      kicker="Step 5 · buyer protection"
      title="Your money is protected"
      sub="Funds stay locked in escrow until you confirm delivery, so you can enjoy risk free bidding. If it never arrives, you get your money back."
    >
      <div className="tut-esc" aria-hidden>
        <div className="tut-esc__track">
          <span className="tut-esc__line" />
          <span className="tut-esc__node tut-esc__node--a"><Avatar handle="you" size={30} /></span>
          <span className="tut-esc__node tut-esc__node--b">
            <Lock className="tut-esc__lock" width={19} height={19} />
            <Check className="tut-esc__check" width={19} height={19} />
          </span>
          <span className="tut-esc__node tut-esc__node--c"><Avatar handle="seller" size={30} /></span>
          <span className="tut-esc__coin">$12</span>
          <span className="tut-esc__pill"><Check width={12} height={12} /> Delivered</span>
        </div>
        <div className="tut-esc__labels"><span>You pay</span><span>Locked in escrow</span><span>Seller paid</span></div>
      </div>
      <button className="btn btn-primary btn-lg tut-cta" onClick={onFinish}>Start exploring <ArrowRight width={17} height={17} /></button>
      <p className="tut-note tut-note--muted">You can replay this anytime from your profile menu.</p>
    </Scene>
  );
}
