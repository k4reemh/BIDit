import { useState } from 'react';
import Logo from './Logo';
import { submitSellerOnboarding, type Session } from '../api';
import { Bolt, Radio, Truck, Shield, Check, ArrowRight, Tag, UserCheck, Wallet } from '../icons';

const LAST = 4;

const HOW = [
  { ic: Radio, t: 'Go live on your stream', d: 'Run auctions and wheel spins right on your pump.fun stream with the BIDit overlay.' },
  { ic: Bolt, t: 'Buyers bid in real time', d: 'Highest bid at the buzzer wins. Anti-snipe keeps it fair — no last-second steals.' },
  { ic: Truck, t: 'You ship, you get paid', d: 'Buyers pay shipping; you keep 95% of each sale in USDC, withdrawable anytime.' },
];

export default function SellerOnboarding({ session, setSession }: { session: Session; setSession: (s: Session) => void }) {
  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  // form
  const [x, setX] = useState(session.socials?.x ?? '');
  const [ig, setIg] = useState(session.socials?.instagram ?? '');
  const [tt, setTt] = useState(session.socials?.tiktok ?? '');
  const [website, setWebsite] = useState(session.website ?? '');
  const [pitch, setPitch] = useState(session.pitch ?? '');
  const [coin, setCoin] = useState(session.pumpCoinAddress ?? '');
  const [country, setCountry] = useState(session.shipping?.originCountry ?? '');
  const [region, setRegion] = useState(session.shipping?.originRegion ?? '');
  const [city, setCity] = useState(session.shipping?.originCity ?? '');
  const [postal, setPostal] = useState(session.shipping?.originPostal ?? '');

  const finish = async () => {
    setBusy(true);
    setError('');
    try {
      const socials: Record<string, string> = {};
      if (x.trim()) socials.x = x.trim();
      if (ig.trim()) socials.instagram = ig.trim();
      if (tt.trim()) socials.tiktok = tt.trim();
      const s = await submitSellerOnboarding({
        website: website.trim(),
        pitch: pitch.trim(),
        coinAddress: coin.trim(),
        socials,
        origin: { country: country.trim(), region: region.trim(), city: city.trim(), postal: postal.trim() },
      });
      setSession(s);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.');
      setBusy(false);
    }
  };

  const next = () => (step < LAST ? setStep(step + 1) : finish());

  return (
    <main className="container sob">
      <div className="sob__top">
        <Logo size={26} />
        <span className="muted">Seller setup · {step + 1} of {LAST + 1}</span>
      </div>
      <div className="sob__bar"><i style={{ width: `${((step + 1) / (LAST + 1)) * 100}%` }} /></div>

      <div className="card sob__card">
        {step === 0 && (
          <>
            <span className="hero__tag"><span className="dot" /> Welcome, seller</span>
            <h1 className="display sob__title">Here’s how selling on BIDit works.</h1>
            <div className="sob__how">
              {HOW.map((h) => (
                <div key={h.t} className="sob__howstep">
                  <span className="sob__howic"><h.ic width={20} height={20} /></span>
                  <div><b>{h.t}</b><p className="muted">{h.d}</p></div>
                </div>
              ))}
            </div>
            <div className="sob__verify">
              <span className="sob__verify-ic"><Shield width={22} height={22} /></span>
              <div>
                <b>Start selling now — get Verified as you go.</b>
                <p className="muted">You’re approved instantly and can list right away. Fulfill <b>10 orders</b> and you automatically become a <b>Verified Seller</b> — you get the badge, buyers trust you more, and you unlock priority support on disputes.</p>
              </div>
            </div>
          </>
        )}

        {step === 1 && (
          <>
            <h1 className="display sob__title">Your shop</h1>
            <p className="muted sob__sub">Link your socials so buyers know it’s really you. All optional — you can add these later in Settings.</p>
            <div className="fld"><label>X / Twitter</label><input value={x} onChange={(e) => setX(e.target.value)} placeholder="@yourhandle" /></div>
            <div className="fld-row">
              <div className="fld"><label>Instagram</label><input value={ig} onChange={(e) => setIg(e.target.value)} placeholder="@yourhandle" /></div>
              <div className="fld"><label>TikTok</label><input value={tt} onChange={(e) => setTt(e.target.value)} placeholder="@yourhandle" /></div>
            </div>
            <div className="fld"><label>Website <span className="muted">— optional</span></label><input value={website} onChange={(e) => setWebsite(e.target.value)} placeholder="https://…" /></div>
            <div className="fld"><label>What do you sell?</label><textarea rows={2} value={pitch} onChange={(e) => setPitch(e.target.value)} placeholder="Pokémon singles, sealed One Piece, streetwear, tech…" /></div>
          </>
        )}

        {step === 2 && (
          <>
            <h1 className="display sob__title">Your stream</h1>
            <p className="muted sob__sub">Paste the pump.fun coin you stream on. Buyers who open its page see your live BIDit auctions, and it links your shop to your stream.</p>
            <div className="fld"><label>Pump.fun coin address</label><input value={coin} onChange={(e) => setCoin(e.target.value)} placeholder="Paste your coin address" /></div>
            <div className="sob__tip"><Radio width={16} height={16} /> No coin yet? You can add it later in Settings — you can still run auctions on the BIDit site.</div>
          </>
        )}

        {step === 3 && (
          <>
            <h1 className="display sob__title">Where do you ship from?</h1>
            <p className="muted sob__sub">We use this to calculate accurate shipping costs for buyers, based on distance and item weight.</p>
            <div className="fld-row">
              <div className="fld"><label>Country</label><input value={country} onChange={(e) => setCountry(e.target.value)} placeholder="US, CA…" /></div>
              <div className="fld"><label>State / Region</label><input value={region} onChange={(e) => setRegion(e.target.value)} placeholder="CA, AB…" /></div>
            </div>
            <div className="fld-row">
              <div className="fld"><label>City</label><input value={city} onChange={(e) => setCity(e.target.value)} placeholder="City" /></div>
              <div className="fld"><label>Postal / ZIP</label><input value={postal} onChange={(e) => setPostal(e.target.value)} placeholder="ZIP / postal" /></div>
            </div>
          </>
        )}

        {step === 4 && (
          <>
            <h1 className="display sob__title">You’re all set. Here’s how to list.</h1>
            <div className="sob__how">
              <div className="sob__howstep"><span className="sob__howic"><Tag width={20} height={20} /></span><div><b>Add an item or a wheel</b><p className="muted">In <b>Listings</b>, add a card/item with a photo, starting bid and weight — or build a randomizer wheel.</p></div></div>
              <div className="sob__howstep"><span className="sob__howic"><Radio width={20} height={20} /></span><div><b>Go live</b><p className="muted">Open <b>Live</b>, start an auction, and it appears on your stream overlay and the BIDit watch page instantly.</p></div></div>
              <div className="sob__howstep"><span className="sob__howic"><Wallet width={20} height={20} /></span><div><b>Ship &amp; get paid</b><p className="muted">Fulfill from <b>Shipments</b>. Each fulfilled order counts toward your <b>Verified</b> badge.</p></div></div>
            </div>
            <div className="sob__verify">
              <span className="sob__verify-ic"><UserCheck width={22} height={22} /></span>
              <div><b>{session.fulfilledCount ?? 0} / {session.verifyThreshold ?? 10} orders to Verified.</b><p className="muted">Keep fulfilling to earn the badge and priority dispute support.</p></div>
            </div>
          </>
        )}

        {error && <div className="auth__error" style={{ marginTop: 14 }}>{error}</div>}

        <div className="sob__actions">
          {step > 0 ? <button className="btn btn-ghost" onClick={() => setStep(step - 1)} disabled={busy}>Back</button> : <span />}
          <button className="btn btn-primary btn-lg" onClick={next} disabled={busy}>
            {busy ? 'Saving…' : step === LAST ? 'Go to dashboard' : 'Continue'} {!busy && <ArrowRight width={18} height={18} />}
          </button>
        </div>
      </div>
    </main>
  );
}
