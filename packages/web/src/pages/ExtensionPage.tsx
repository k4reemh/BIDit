import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Radio, Bag, Truck, Shield, Wallet, ArrowRight, Check, Chevron } from '../icons';

const ZIP = '/BIDit-extension.zip';

const STEPS = [
  { n: 1, t: 'Download the extension', d: 'Grab the BIDit extension file below. It is a small zip, a few seconds on any connection.', dl: true },
  { n: 2, t: 'Unzip it', d: 'Double-click the file to unzip it. You will get a folder called dist. Keep it somewhere you will not delete, like your Documents.' },
  { n: 3, t: 'Open your extensions page', d: 'In Chrome, Brave, or Edge, type chrome://extensions in the address bar and press enter.' },
  { n: 4, t: 'Turn on Developer mode', d: 'Flip the Developer mode switch in the top-right corner of that page.' },
  { n: 5, t: 'Load the folder', d: 'Click Load unpacked, then choose the dist folder you just unzipped. BIDit appears in your list.' },
  { n: 6, t: 'Pin it and sign in', d: 'Pin BIDit to your toolbar, click the icon, and sign in with your BIDit account. That is it.' },
];

const FEATURES = [
  { icon: <Radio width={22} height={22} />, t: 'Bids right on the stream', d: 'The panel floats over any pump.fun coin page. No new tab, no second screen.' },
  { icon: <Wallet width={22} height={22} />, t: 'Real USDC, one tap', d: 'Bid from your BIDit balance. Your funds are held in escrow until the item ships.' },
  { icon: <Radio width={22} height={22} />, t: 'Auto-detects auctions', d: 'Open a stream that is running a BIDit auction and the panel appears on its own.' },
  { icon: <Bag width={22} height={22} />, t: 'Anti-snipe timer', d: 'A late bid pushes the clock back a few seconds, so nobody steals it at 0:01.' },
  { icon: <Truck width={22} height={22} />, t: 'Wins ship to your door', d: 'Take the item at the buzzer and the seller ships it. You confirm, everyone gets paid.' },
  { icon: <Shield width={22} height={22} />, t: 'Nothing extra to trust', d: 'It talks only to BIDit and stores only your sign-in. No page data leaves your browser.' },
];

const FAQ = [
  { q: 'Which browsers work?', a: 'Any Chromium browser: Chrome, Brave, Edge, Arc, and Opera. Safari and Firefox are not supported yet.' },
  { q: 'Do I need SOL for gas?', a: 'No. BIDit covers the network fees on both deposits and withdrawals. You just fund your balance with USDC or SOL and bid.' },
  { q: 'Is it safe to load unpacked?', a: 'Yes. Loading unpacked is the standard way to run an extension before it is on the store. The code only reaches the BIDit backend and pump.fun pages, and the only thing it saves is your session so you stay signed in.' },
  { q: 'Why not the Chrome Web Store?', a: 'It is on the way. Store review takes a few days, so the unpacked build lets you bid on stream today. When it is approved you can switch over with one click.' },
  { q: 'Do I bid with the same account as the website?', a: 'Yes. It is one account and one balance. Deposit or win on the site or in the extension, it is all the same wallet.' },
];

export default function ExtensionPage() {
  const [open, setOpen] = useState<number | null>(0);

  return (
    <main className="ext">
      {/* ---- hero ---- */}
      <section className="container ext-hero">
        <div className="ext-hero__copy">
          <span className="ext-eyebrow"><Radio width={15} height={15} /> Browser extension · Free</span>
          <h1 className="display ext-hero__title">Bid without leaving the stream.</h1>
          <p className="ext-hero__sub">
            The BIDit extension drops a live bidding panel right onto the pump.fun page. When a seller
            runs an auction, it appears on its own. Place real USDC bids, win at the buzzer, and it ships to your door.
          </p>
          <div className="ext-hero__cta">
            <a className="btn btn-primary btn-lg" href={ZIP} download>Download for Chrome</a>
            <a className="btn btn-ghost btn-lg" href="#install">How to install</a>
          </div>
          <div className="ext-hero__meta">
            <span><Check width={15} height={15} /> Chrome, Brave, Edge</span>
            <span><Check width={15} height={15} /> About a minute to set up</span>
          </div>
        </div>

        <div className="ext-hero__demo">
          <div className="ext-browser">
            <div className="ext-browser__bar">
              <i className="ext-dot ext-dot--r" /><i className="ext-dot ext-dot--y" /><i className="ext-dot ext-dot--g" />
              <div className="ext-browser__url">pump.fun/coin</div>
            </div>
            <video className="ext-browser__vid" src="/extension-demo.mp4" poster="/extension-demo-poster.jpg" autoPlay muted loop playsInline />
          </div>
        </div>
      </section>

      {/* ---- how it works ---- */}
      <section className="section container">
        <div className="ext-section-head">
          <h2 className="display ext-h2">How it works</h2>
          <p className="muted">Three steps, and you are bidding on the stream.</p>
        </div>
        <div className="ext-how">
          <div className="ext-how__step">
            <div className="ext-how__ic"><Radio width={24} height={24} /></div>
            <b>Open a live stream</b>
            <p>Head to any seller streaming on pump.fun and running a BIDit auction.</p>
          </div>
          <div className="ext-how__arrow"><ArrowRight width={22} height={22} /></div>
          <div className="ext-how__step">
            <div className="ext-how__ic"><Bag width={24} height={24} /></div>
            <b>The panel appears</b>
            <p>The extension spots the auction and overlays your bidding panel automatically.</p>
          </div>
          <div className="ext-how__arrow"><ArrowRight width={22} height={22} /></div>
          <div className="ext-how__step">
            <div className="ext-how__ic"><Truck width={24} height={24} /></div>
            <b>Bid, win, get it shipped</b>
            <p>Highest bid at the buzzer takes it. Your money sits in escrow until it lands.</p>
          </div>
        </div>
      </section>

      {/* ---- install guide ---- */}
      <section className="section" id="install">
        <div className="container">
          <div className="ext-section-head">
            <h2 className="display ext-h2">Install in about a minute</h2>
            <p className="muted">The store version is coming. Until then, load the unpacked build. It is quick.</p>
          </div>
          <div className="ext-install">
            <ol className="ext-steps">
              {STEPS.map((s) => (
                <li key={s.n} className="ext-step">
                  <span className="ext-step__num">{s.n}</span>
                  <div className="ext-step__body">
                    <b>{s.t}</b>
                    <p>{s.d}</p>
                    {s.dl && (
                      <a className="btn btn-primary ext-step__dl" href={ZIP} download>Download the extension</a>
                    )}
                  </div>
                </li>
              ))}
            </ol>
            <aside className="ext-note card">
              <Shield width={18} height={18} />
              <div>
                <b>Good to know</b>
                <p>Keep the unzipped folder where it is. If you move or delete it, the browser will turn the extension off until you load it again.</p>
              </div>
            </aside>
          </div>
        </div>
      </section>

      {/* ---- features ---- */}
      <section className="section container">
        <div className="ext-section-head">
          <h2 className="display ext-h2">What you get</h2>
        </div>
        <div className="ext-feat-grid">
          {FEATURES.map((f) => (
            <div key={f.t} className="ext-feat card">
              <div className="ext-feat__ic">{f.icon}</div>
              <b>{f.t}</b>
              <p>{f.d}</p>
            </div>
          ))}
        </div>
      </section>

      {/* ---- faq ---- */}
      <section className="section container ext-faq-wrap">
        <div className="ext-section-head">
          <h2 className="display ext-h2">Questions</h2>
        </div>
        <div className="ext-faq">
          {FAQ.map((f, i) => (
            <button key={f.q} className={`ext-faq__item${open === i ? ' is-open' : ''}`} onClick={() => setOpen(open === i ? null : i)}>
              <div className="ext-faq__q"><span>{f.q}</span><Chevron width={20} height={20} /></div>
              <div className="ext-faq__a"><p>{f.a}</p></div>
            </button>
          ))}
        </div>
      </section>

      {/* ---- final cta ---- */}
      <section className="section container">
        <div className="ext-cta">
          <div className="ext-cta__glow" />
          <h2 className="display ext-cta__title">Ready to bid on the stream?</h2>
          <p className="ext-cta__sub">Add the extension, open a live pump.fun auction, and take your shot.</p>
          <div className="ext-cta__row">
            <a className="btn btn-accent btn-lg" href={ZIP} download>Download for Chrome</a>
            <Link className="btn btn-ghost btn-lg" to="/browse">See who is live</Link>
          </div>
        </div>
      </section>
    </main>
  );
}
