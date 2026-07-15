import { useState } from 'react';
import Logo from './Logo';
import { INTERESTS, CATEGORIES } from '../data';
import { completeOnboarding, type Session } from '../api';
import { Bolt, Truck, Wallet, Shield, Copy, Check, ArrowRight, Gift } from '../icons';

const HOW = [
  { ic: Bolt, t: 'Bid live on stream', d: 'Jump into a seller’s live pump.fun stream and place real bids in real time.' },
  { ic: Truck, t: 'Win it, seller ships it', d: 'Your funds stay put until you win — then the seller ships it straight to your door.' },
  { ic: Wallet, t: 'Settle in USDC', d: 'Fast, on-chain settlement. No chargebacks, no haggling, no middlemen.' },
];
const VALUES = [
  { ic: Bolt, t: 'Real-time live auctions' },
  { ic: Truck, t: 'Win it — seller ships it' },
  { ic: Shield, t: 'USDC settled · buyer protection' },
];
const HANDLE_RE = /^[a-z0-9_]{3,20}$/;
const LAST = 4;
const TITLES = ['Welcome to BIDit', 'Claim your username', 'What do you collect?', 'Fund your first bid', 'Earn points, catch airdrops'];
const POINTS_PERKS = [
  { pts: '100×', t: 'points on every $1 you spend' },
  { pts: '20×', t: 'points on every $1 you sell' },
  { pts: '+1,000', t: 'deposit USDC into your wallet' },
  { pts: '+3,000', t: 'win your first auction' },
];

export default function Onboarding({ session, onDone }: { session: Session; onDone: (s: Session) => void }) {
  const [step, setStep] = useState(0);
  const [handle, setHandle] = useState(session.handle.startsWith('collector_') ? '' : session.handle);
  const [interests, setInterests] = useState<Set<string>>(new Set());
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  const toggle = (id: string) =>
    setInterests((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });

  const copy = () => {
    if (!session.depositAddress) return;
    navigator.clipboard?.writeText(session.depositAddress).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    });
  };

  const finish = async (skip = false) => {
    setBusy(true);
    setError('');
    try {
      onDone(await completeOnboarding({ handle: handle.trim() || undefined, interests: [...interests] }));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.');
      setBusy(false);
      if (!skip) setStep(1);
    }
  };

  const next = () => {
    setError('');
    if (step === 1) {
      const h = handle.trim().toLowerCase();
      if (!HANDLE_RE.test(h)) { setError('3–20 characters: letters, numbers or underscores.'); return; }
    }
    if (step < LAST) setStep(step + 1);
    else finish();
  };

  return (
    <div className="obx">
      {/* left — brand / value panel */}
      <aside className="obx__brand">
        <div className="obx__brandtop"><Logo size={30} /></div>
        <div className="obx__pitch">
          <h1 className="obx__pitchhead">The live marketplace for bidding on anything.</h1>
          <ul className="obx__values">
            {VALUES.map((v) => (
              <li key={v.t}><span className="obx__valic"><v.ic width={17} height={17} /></span>{v.t}</li>
            ))}
          </ul>
        </div>
        <div className="obx__thumbs">
          {CATEGORIES.slice(0, 4).map((c) => (
            <img key={c.name} className="obx__thumb" src={c.image} alt="" loading="lazy" />
          ))}
        </div>
        <div className="obx__brandfoot">Settles in USDC · Built on Solana</div>
      </aside>

      {/* right — step panel */}
      <main className="obx__panel">
        <div className="obx__head">
          <div className="obx__steps">
            {[0, 1, 2, 3, 4].map((i) => <span key={i} className={`obx__seg${i <= step ? ' on' : ''}`} />)}
          </div>
          <button className="obx__skip" onClick={() => finish(true)} disabled={busy}>Skip for now</button>
        </div>

        <div className="obx__body" key={step}>
          <div className="obx__eyebrow">Step {step + 1} of {LAST + 1}</div>
          <h2 className="display obx__title">{TITLES[step]}</h2>

          {step === 0 && (
            <>
              <p className="obx__sub">Here’s the whole loop — it takes about twenty seconds.</p>
              <div className="obx__how">
                {HOW.map((h) => (
                  <div className="obx__howrow" key={h.t}>
                    <span className="obx__howic"><h.ic width={20} height={20} /></span>
                    <div><b>{h.t}</b><span>{h.d}</span></div>
                  </div>
                ))}
              </div>
            </>
          )}

          {step === 1 && (
            <>
              <p className="obx__sub">This is how other collectors will know you. You can change it anytime.</p>
              <div className="obx__handle">
                <span>@</span>
                <input autoFocus placeholder="cardcollector" value={handle}
                  onChange={(e) => setHandle(e.target.value.replace(/\s/g, ''))}
                  onKeyDown={(e) => e.key === 'Enter' && next()} />
              </div>
              {error && <div className="obx__error">{error}</div>}
            </>
          )}

          {step === 2 && (
            <>
              <p className="obx__sub">Pick a few and we’ll tailor your live feed. You can skip this.</p>
              <div className="obx__chips">
                {INTERESTS.map((it) => (
                  <button key={it.id} type="button" className={`obx__chip${interests.has(it.id) ? ' on' : ''}`} onClick={() => toggle(it.id)}>
                    {interests.has(it.id) && <Check width={14} height={14} />}{it.label}
                  </button>
                ))}
              </div>
            </>
          )}

          {step === 3 && (
            <>
              <p className="obx__sub">We generated a Solana wallet just for you. Send <b>USDC or SOL</b> to it to fund your bids — every auction settles from this balance.</p>
              <div className="obx__wallet">
                <span className="obx__wallet-label"><Wallet width={15} height={15} /> Your deposit address</span>
                <div className="obx__wallet-addr">
                  <code>{session.depositAddress ?? 'generating…'}</code>
                  <button type="button" onClick={copy}>{copied ? <Check width={15} height={15} /> : <Copy width={15} height={15} />}{copied ? 'Copied' : 'Copy'}</button>
                </div>
                <div className="obx__wallet-note">Send only USDC or SOL on Solana to this address. Funds appear in your balance once the transfer confirms.</div>
              </div>
            </>
          )}

          {step === 4 && (
            <>
              <p className="obx__sub">
                Everything you do on BIDit earns <b>BIDit Points</b> — and points decide your share of the
                <b> $BID community airdrops</b> (5% of supply is locked for them, first drop one month after launch).
              </p>
              <div className="obx__how">
                {POINTS_PERKS.map((p) => (
                  <div className="obx__howrow" key={p.t}>
                    <span className="obx__howic obx__howic--pts">{p.pts}</span>
                    <div><b>{p.pts} points</b><span>{p.t}</span></div>
                  </div>
                ))}
              </div>
              <p className="obx__sub" style={{ marginTop: 12 }}>
                <Gift width={14} height={14} style={{ verticalAlign: '-2px', marginRight: 6 }} />
                Find your missions anytime under <b>BIDit Points</b> in your profile menu.
              </p>
            </>
          )}

          {error && step !== 1 && <div className="obx__error">{error}</div>}
        </div>

        <div className="obx__foot">
          {step > 0
            ? <button className="btn btn-ghost" onClick={() => { setError(''); setStep(step - 1); }} disabled={busy}>Back</button>
            : <span />}
          <button className="btn btn-primary btn-lg obx__next" onClick={next} disabled={busy}>
            {busy ? 'Setting up…' : step === 0 ? 'Get started' : step === LAST ? 'Start bidding' : 'Continue'}
            {!busy && <ArrowRight width={18} height={18} />}
          </button>
        </div>
      </main>
    </div>
  );
}
