import { useEffect, useState } from 'react';
import Logo from './Logo';
import { INTERESTS } from '../data';
import { completeOnboarding, setHandle as claimHandle, updateMe, ApiError, type Session } from '../api';
import { Radio, Truck, Wallet, Copy, Check, ArrowRight, Gift } from '../icons';

const HOW = [
  { ic: Radio, t: 'Bid live on stream', d: 'Jump into a seller’s live pump.fun stream and place real bids in real time.' },
  { ic: Truck, t: 'Win it, seller ships it', d: 'Your funds stay put until you win. Then the seller ships it straight to your door.' },
  { ic: Wallet, t: 'Settle in USDC', d: 'Fast, on-chain settlement. No chargebacks, no haggling, no middlemen.' },
];
const HANDLE_RE = /^[a-z0-9_]{3,20}$/;
const LAST = 5;
/** The one step nobody can skip — everything downstream keys off the username. */
const HANDLE_STEP = 1;
const TITLES = [
  'Welcome to BIDit',
  'Claim your username',
  'What do you collect?',
  'Where should your wins ship?',
  'Fund your first bid',
  'Earn points, catch airdrops',
];
/** Delivery address. Skippable, but everything you win waits until it's set. */
const ADDRESS_STEP = 3;
const POINTS_PERKS = [
  { pts: '100×', t: 'on every $1 you spend' },
  { pts: '20×', t: 'on every $1 you sell' },
  { pts: '+1,000', t: 'deposit USDC into your wallet' },
  { pts: '+3,000', t: 'win your first auction' },
];

export default function Onboarding({
  session,
  onDone,
  onDismiss,
}: {
  session: Session;
  onDone: (s: Session) => void;
  /** Close without finishing. The account already exists — they just haven't
   *  set it up — so this leaves them signed in and shows the flow again next
   *  visit. Everything here is reachable later from Settings. */
  onDismiss: () => void;
}) {
  const [step, setStep] = useState(0);
  const [handle, setHandle] = useState(session.handle.startsWith('collector_') ? '' : session.handle);
  const [interests, setInterests] = useState<Set<string>>(new Set());
  const a = session.shippingAddress;
  const [shipName, setShipName] = useState(a?.name ?? session.displayName ?? '');
  const [line1, setLine1] = useState(a?.line1 ?? '');
  const [line2, setLine2] = useState(a?.line2 ?? '');
  const [city, setCity] = useState(a?.city ?? '');
  const [region, setRegion] = useState(a?.region ?? '');
  const [postal, setPostal] = useState(a?.postal ?? '');
  const [country, setCountry] = useState(a?.country ?? '');
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

  const finish = async () => {
    setBusy(true);
    setError('');
    try {
      onDone(await completeOnboarding({ handle: handle.trim() || undefined, interests: [...interests] }));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.');
      setBusy(false);
      setStep(1); // the only thing that can still fail here is the username
    }
  };

  const next = async () => {
    setError('');
    // Claim the username on THIS step rather than at the end of the flow, so a
    // taken name is reported here instead of four screens later.
    if (step === HANDLE_STEP) {
      const h = handle.trim().toLowerCase();
      if (!HANDLE_RE.test(h)) { setError('3–20 characters: letters, numbers or underscores.'); return; }
      setBusy(true);
      try {
        await claimHandle(h);
      } catch (err) {
        // A backend that predates /me/handle answers 404. That's a deploy-skew
        // problem, not the user's — don't strand them on this step; the final
        // submit still validates the name.
        if (!(err instanceof ApiError && err.status === 404)) {
          setError(err instanceof Error ? err.message : 'Could not take that username.');
          return;
        }
      } finally {
        setBusy(false);
      }
    }
    if (step === ADDRESS_STEP && (shipName.trim() || line1.trim())) {
      // Partly filled is still worth keeping — they can finish it in Settings.
      setBusy(true);
      try {
        await updateMe({
          shippingAddress: {
            name: shipName.trim(),
            line1: line1.trim(),
            line2: line2.trim(),
            city: city.trim(),
            region: region.trim(),
            postal: postal.trim(),
            country: country.trim(),
          },
        });
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Could not save that address.');
        return;
      } finally {
        setBusy(false);
      }
    }
    if (step < LAST) setStep(step + 1);
    else void finish();
  };

  // Esc closes it, like any dismissible overlay.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onDismiss(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onDismiss]);

  return (
    // A centered popup over the site — one focused card, no split-screen.
    <div className="obx" onClick={onDismiss}>
      <main className="obx__panel" onClick={(e) => e.stopPropagation()}>
        <button className="obx__close" onClick={onDismiss} aria-label="Close setup">×</button>
        <div className="obx__head">
          <Logo size={22} />
          <div className="obx__steps">
            {Array.from({ length: LAST + 1 }, (_, i) => (
              <span key={i} className={`obx__seg${i <= step ? ' on' : ''}`} />
            ))}
          </div>
          {/* No skip-the-whole-thing button: the username is required, and the
              optional steps carry their own "Add later" in the footer. */}
          <span className="obx__headpad" aria-hidden />
        </div>

        <div className="obx__body" key={step}>
          <div className="obx__eyebrow">Step {step + 1} of {LAST + 1}</div>
          <h2 className="display obx__title">{TITLES[step]}</h2>

          {step === 0 && (
            <>
              <p className="obx__sub">Here’s the whole loop. Takes about twenty seconds.</p>
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

          {step === ADDRESS_STEP && (
            <>
              <p className="obx__sub">
                This is where your wins get shipped, and it&rsquo;s what we print on the label. You
                can add it later, but nothing ships until it&rsquo;s on file. Sellers never see it.
              </p>
              <div className="fld"><label>Full name</label><input value={shipName} onChange={(e) => setShipName(e.target.value)} placeholder="Name on the package" autoFocus /></div>
              <div className="fld"><label>Street address</label><input value={line1} onChange={(e) => setLine1(e.target.value)} placeholder="123 Main St" /></div>
              <div className="fld"><label>Apt, suite, unit <span className="muted">(optional)</span></label><input value={line2} onChange={(e) => setLine2(e.target.value)} placeholder="Unit 4" /></div>
              <div className="fld-row">
                <div className="fld"><label>City</label><input value={city} onChange={(e) => setCity(e.target.value)} placeholder="City" /></div>
                <div className="fld"><label>State / Region</label><input value={region} onChange={(e) => setRegion(e.target.value)} placeholder="CA, AB…" /></div>
              </div>
              <div className="fld-row">
                <div className="fld"><label>Postal / ZIP</label><input value={postal} onChange={(e) => setPostal(e.target.value)} placeholder="ZIP / postal" /></div>
                <div className="fld"><label>Country</label><input value={country} onChange={(e) => setCountry(e.target.value)} placeholder="US, CA…" /></div>
              </div>
            </>
          )}

          {step === 4 && (
            <>
              <p className="obx__sub">We generated a Solana deposit address just for you. Send it <b>USDC</b> to fund your bids. Every auction settles from this balance, and you can withdraw it any time.</p>
              <div className="obx__wallet">
                <span className="obx__wallet-label"><Wallet width={15} height={15} /> Your deposit address</span>
                <div className="obx__wallet-addr">
                  <code>{session.depositAddress ?? 'generating…'}</code>
                  <button type="button" onClick={copy}>{copied ? <Check width={15} height={15} /> : <Copy width={15} height={15} />}{copied ? 'Copied' : 'Copy'}</button>
                </div>
                <div className="obx__wallet-note"><b>Send only USDC on Solana.</b> It is swept into the BIDit treasury and credited to your account balance, usually within a minute.</div>
              </div>
            </>
          )}

          {step === 5 && (
            <>
              <p className="obx__sub">
                Everything you do on BIDit earns <b>BIDit Points</b>. Points decide your share of the
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
          {step !== HANDLE_STEP && step !== 0 && (
            <button
              className="obx__later"
              onClick={() => { setError(''); step < LAST ? setStep(step + 1) : void finish(); }}
              disabled={busy}
            >
              Add later
            </button>
          )}
          <button className="btn btn-primary btn-lg obx__next" onClick={() => void next()} disabled={busy}>
            {busy ? 'Setting up…' : step === 0 ? 'Get started' : step === LAST ? 'Start bidding' : 'Continue'}
            {!busy && <ArrowRight width={18} height={18} />}
          </button>
        </div>
      </main>
    </div>
  );
}
