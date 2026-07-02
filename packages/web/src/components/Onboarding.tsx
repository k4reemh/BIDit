import { useState } from 'react';
import Logo from './Logo';
import { INTERESTS } from '../data';
import { completeOnboarding, type Session } from '../api';
import { Bolt, Truck, Wallet, Copy, Check, ArrowRight } from '../icons';

const HOW = [
  { ic: Bolt, t: 'Bid live on stream', d: 'Jump into a seller’s pump.fun break and place real bids in real time.' },
  { ic: Truck, t: 'Win it, we ship it', d: 'Your funds sit safely in escrow until the card lands in your hands.' },
  { ic: Wallet, t: 'Settle in USDC', d: 'Fast, on-chain settlement — no chargebacks, no haggling.' },
];
const HANDLE_RE = /^[a-z0-9_]{3,20}$/;
const LAST = 3;

export default function Onboarding({ session, onDone }: { session: Session; onDone: (s: Session) => void }) {
  const [step, setStep] = useState(0);
  const [handle, setHandle] = useState(session.handle.startsWith('collector_') ? '' : session.handle);
  const [interests, setInterests] = useState<Set<string>>(new Set());
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  const toggle = (id: string) =>
    setInterests((s) => {
      const n = new Set(s);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });

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
      const s = await completeOnboarding({ handle: handle.trim() || undefined, interests: [...interests] });
      onDone(s);
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
      if (!HANDLE_RE.test(h)) {
        setError('3–20 characters: letters, numbers or underscores.');
        return;
      }
    }
    if (step < LAST) setStep(step + 1);
    else finish();
  };

  return (
    <div className="ob__scrim">
      <div className="ob">
        <div className="ob__top">
          <Logo size={26} />
          <button className="ob__skip" onClick={() => finish(true)} disabled={busy}>Skip for now</button>
        </div>

        <div className="ob__progress">
          {[0, 1, 2, 3].map((i) => <span key={i} className={`ob__dot${i <= step ? ' on' : ''}`} />)}
        </div>

        <div className="ob__body">
          {step === 0 && (
            <>
              <h2 className="display ob__title">Welcome to BIDit</h2>
              <p className="ob__sub">Here’s how it works — takes about 20 seconds.</p>
              <div className="ob__how">
                {HOW.map((h) => (
                  <div className="ob__howrow" key={h.t}>
                    <span className="ob__howic"><h.ic width={20} height={20} /></span>
                    <div><b>{h.t}</b><span>{h.d}</span></div>
                  </div>
                ))}
              </div>
            </>
          )}

          {step === 1 && (
            <>
              <h2 className="display ob__title">Pick your username</h2>
              <p className="ob__sub">This is how other collectors will know you. You can change it later.</p>
              <div className="ob__handle">
                <span>@</span>
                <input autoFocus placeholder="cardcollector" value={handle} onChange={(e) => setHandle(e.target.value.replace(/\s/g, ''))} onKeyDown={(e) => e.key === 'Enter' && next()} />
              </div>
              {error && <div className="ob__error">{error}</div>}
            </>
          )}

          {step === 2 && (
            <>
              <h2 className="display ob__title">What are you collecting?</h2>
              <p className="ob__sub">Pick a few — we’ll tailor your live feed. Optional.</p>
              <div className="ob__chips">
                {INTERESTS.map((it) => (
                  <button key={it.id} className={`ob__chip${interests.has(it.id) ? ' on' : ''}`} onClick={() => toggle(it.id)} type="button">
                    <span className="ob__chipg">{it.glyph}</span> {it.label}
                  </button>
                ))}
              </div>
              {error && <div className="ob__error">{error}</div>}
            </>
          )}

          {step === 3 && (
            <>
              <h2 className="display ob__title">Your deposit wallet</h2>
              <p className="ob__sub">We generated a Solana wallet just for you. <b>Deposit USDC or SOL to it to fund your bids</b> — every auction settles from this balance.</p>
              <div className="ob__wallet">
                <span className="ob__wallet-label"><Wallet width={15} height={15} /> Your deposit address</span>
                <div className="ob__wallet-addr">
                  <code>{session.depositAddress ?? 'generating…'}</code>
                  <button type="button" onClick={copy}>{copied ? <Check width={15} height={15} /> : <Copy width={15} height={15} />}{copied ? 'Copied' : 'Copy'}</button>
                </div>
                <div className="ob__wallet-note">◎ Solana devnet · send only USDC or SOL to this address. Funds appear in your balance once the transfer confirms.</div>
              </div>
            </>
          )}
        </div>

        <div className="ob__foot">
          {step > 0 ? (
            <button className="btn btn-ghost" onClick={() => { setError(''); setStep(step - 1); }} disabled={busy}>Back</button>
          ) : (
            <span />
          )}
          <button className="btn btn-primary" onClick={next} disabled={busy}>
            {busy ? 'Setting up…' : step === 0 ? 'Get started' : step === LAST ? 'Start bidding' : 'Continue'}
            {!busy && <ArrowRight width={17} height={17} />}
          </button>
        </div>
      </div>
    </div>
  );
}
