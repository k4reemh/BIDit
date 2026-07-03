import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useCopy } from '../ContentProvider';
import {
  Bolt, Radio, Eye, Wallet, Shield, Tag, Gift, Dice, UserCheck, Info, Book, ArrowRight, Truck,
} from '../icons';

const SECTIONS = [
  { id: 'overview', label: 'What is BIDit', icon: Bolt },
  { id: 'how', label: 'How an auction works', icon: Radio },
  { id: 'overlay', label: 'Getting the overlay', icon: Eye },
  { id: 'balance', label: 'Balance & deposits', icon: Wallet },
  { id: 'escrow', label: 'Escrow & settlement', icon: Shield },
  { id: 'shipping', label: 'Shipping & delivery', icon: Truck },
  { id: 'fees', label: 'Fees', icon: Tag },
  { id: 'tokenomics', label: '$BID tokenomics', icon: Gift },
  { id: 'randomizer', label: 'The randomizer', icon: Dice },
  { id: 'selling', label: 'Selling on BIDit', icon: UserCheck },
  { id: 'safety', label: 'Safety & trust', icon: Info },
  { id: 'faq', label: 'FAQ', icon: Book },
];

export default function Docs() {
  const t = useCopy();
  const [active, setActive] = useState('overview');

  useEffect(() => {
    const obs = new IntersectionObserver(
      (entries) => {
        const vis = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (vis[0]) setActive(vis[0].target.id);
      },
      { rootMargin: '-96px 0px -60% 0px', threshold: 0 },
    );
    SECTIONS.forEach((s) => {
      const el = document.getElementById(s.id);
      if (el) obs.observe(el);
    });
    return () => obs.disconnect();
  }, []);

  return (
    <main className="container docs">
      <aside className="docs__toc">
        <div className="docs__toc-inner">
          <span className="docs__toc-h">Documentation</span>
          <nav className="docs__nav">
            {SECTIONS.map((s) => (
              <a key={s.id} href={`#${s.id}`} className={`docs__navlink${active === s.id ? ' active' : ''}`}>
                <s.icon width={17} height={17} /> {s.label}
              </a>
            ))}
          </nav>
        </div>
      </aside>

      <article className="docs__body">
        <header className="docs__hero">
          <span className="hero__tag"><span className="dot" /> Docs · Beta (devnet)</span>
          <h1 className="display docs__h1">{t('docs.hero.title')}</h1>
          <p className="docs__lead">{t('docs.hero.lead')}</p>
        </header>

        {/* OVERVIEW */}
        <section id="overview" className="docs__sec">
          <h2 className="docs__h2"><Bolt width={22} height={22} /> What is BIDit</h2>
          <p>
            BIDit is <b>“Whatnot for degens.”</b> A seller goes live on pump.fun to show off cards; the BIDit browser
            overlay drops a live auction panel right onto the stream. Viewers place bids in real time, the highest
            bidder when the clock hits zero wins, and the card ships to them. Money moves in USDC — no chat comments,
            no manual invoicing, no “DM me to pay.”
          </p>
          <div className="docs__cards3">
            <div className="docs__mini card">
              <span className="docs__mini-ic"><Radio width={18} height={18} /></span>
              <b>Live, on the stream</b>
              <p className="muted">The auction runs as an overlay on the pump.fun page you’re already watching.</p>
            </div>
            <div className="docs__mini card">
              <span className="docs__mini-ic"><Wallet width={18} height={18} /></span>
              <b>Settled in USDC</b>
              <p className="muted">You fund a balance once and bid instantly. Winning captures your bid into escrow.</p>
            </div>
            <div className="docs__mini card">
              <span className="docs__mini-ic"><Gift width={18} height={18} /></span>
              <b>Every ship pumps $BID</b>
              <p className="muted">5% of each shipped sale routes to an on-chain $BID buyback — the flywheel.</p>
            </div>
          </div>
          <div className="docs__note">
            <Info width={18} height={18} />
            <p><b>Core principle:</b> the server is authoritative. The overlay and website only render state — every bid,
            hold, and payout is decided and recorded server-side on a double-entry ledger, so balances can never
            drift or double-spend.</p>
          </div>
        </section>

        {/* HOW IT WORKS */}
        <section id="how" className="docs__sec">
          <h2 className="docs__h2"><Radio width={22} height={22} /> How a live auction works</h2>
          <p>A single auction runs through the same lifecycle every time:</p>
          <ol className="docs__steps">
            <li>
              <span className="docs__step-n">1</span>
              <div>
                <b>Seller starts the auction</b>
                <p className="muted">The seller queues a card, then hits “Start auction” on their stream. The overlay
                appears for every viewer with the item, photo, and a starting bid.</p>
              </div>
            </li>
            <li>
              <span className="docs__step-n">2</span>
              <div>
                <b>Viewers bid from their balance</b>
                <p className="muted">Each bid must beat the current price. The moment your bid is accepted, that amount
                is <b>held</b> from your available balance so you can always cover it. Get outbid and the hold releases
                instantly.</p>
              </div>
            </li>
            <li>
              <span className="docs__step-n">3</span>
              <div>
                <b>Anti-snipe keeps it fair</b>
                <p className="muted">A bid in the final seconds nudges the clock forward a beat so there’s always a
                chance to answer — the timer can never sit more than ~5 seconds out. No last-millisecond steals.</p>
              </div>
            </li>
            <li>
              <span className="docs__step-n">4</span>
              <div>
                <b>Highest bid at zero wins</b>
                <p className="muted">When the clock ends, the top bidder wins. Their held bid is <b>captured into
                escrow</b> — everyone else’s holds are released back to their balance.</p>
              </div>
            </li>
            <li>
              <span className="docs__step-n">5</span>
              <div>
                <b>Ship → settle</b>
                <p className="muted">The seller ships the card. Once it’s delivered and the dispute window passes,
                escrow releases: 95% to the seller, 5% to the $BID buyback.</p>
              </div>
            </li>
          </ol>
        </section>

        {/* OVERLAY */}
        <section id="overlay" className="docs__sec">
          <h2 className="docs__h2"><Eye width={22} height={22} /> Getting the overlay</h2>
          <p>
            The overlay is a lightweight browser extension. It injects the auction panel onto pump.fun coin pages and
            talks to BIDit securely in the background — the stream page can’t see or block it.
          </p>
          <ol className="docs__steps">
            <li>
              <span className="docs__step-n">1</span>
              <div>
                <b>Install the extension</b>
                <p className="muted">During beta it loads unpacked: build the extension, then in Chrome open
                <code> chrome://extensions</code>, enable Developer mode, and “Load unpacked” the <code>dist/</code>
                folder. (A one-click Chrome Web Store listing is coming for launch.)</p>
              </div>
            </li>
            <li>
              <span className="docs__step-n">2</span>
              <div>
                <b>Sign in & fund your balance</b>
                <p className="muted">Open the BIDit popup, sign in, and deposit USDC to your balance (see
                <a href="#balance"> Balance & deposits</a>). You bid from this balance — no wallet pop-up per bid.</p>
              </div>
            </li>
            <li>
              <span className="docs__step-n">3</span>
              <div>
                <b>Open a live seller’s pump.fun page</b>
                <p className="muted">When a seller is live and running an auction, the panel appears in the top-right of
                the stream. It’s draggable, shows the current bid, a countdown, the leader, and a live bid feed.</p>
              </div>
            </li>
            <li>
              <span className="docs__step-n">4</span>
              <div>
                <b>Bid</b>
                <p className="muted">Tap BID to place the next increment, or wait and snipe. If you win, a full-screen
                “You won” celebration fires and the order lands in your Purchases.</p>
              </div>
            </li>
          </ol>
          <div className="docs__note">
            <Info width={18} height={18} />
            <p>You can also watch and manage auctions from the website — sellers get a live monitor at
            <Link to="/seller/live"> Seller → Live</Link>, and every account can track bids and orders from their
            dashboard. The overlay is just the fastest way to bid while watching.</p>
          </div>
        </section>

        {/* BALANCE */}
        <section id="balance" className="docs__sec">
          <h2 className="docs__h2"><Wallet width={22} height={22} /> Balance & deposits</h2>
          <p>
            You bid from a prepaid USDC balance so bids land instantly. When you sign up, BIDit generates a personal
            Solana <b>deposit address</b> just for you.
          </p>
          <div className="docs__deflow">
            <div className="docs__deflow-step"><b>Deposit</b><p className="muted">Send USDC (or SOL) to your deposit address. Incoming funds are detected on-chain and credited to your <b>available</b> balance automatically.</p></div>
            <ArrowRight className="docs__deflow-arrow" width={18} height={18} />
            <div className="docs__deflow-step"><b>Bid</b><p className="muted">A live bid <b>holds</b> that amount. Held funds sit in your balance but can’t be spent twice — outbid releases them.</p></div>
            <ArrowRight className="docs__deflow-arrow" width={18} height={18} />
            <div className="docs__deflow-step"><b>Withdraw</b><p className="muted">Any available (un-held) balance can be withdrawn back to a Solana address anytime.</p></div>
          </div>
          <p className="muted docs__afterflow">
            Your dashboard splits this into two numbers: <b>Available</b> (free to bid or withdraw) and <b>Held in
            active bids</b> (committed to auctions you’re currently leading). You’ll find your address, a live balance,
            and the withdraw form under <Link to="/deposit">Account → Deposit</Link>.
          </p>
          <div className="docs__note">
            <Shield width={18} height={18} />
            <p><b>On keys:</b> BIDit never asks you for a private key, and never stores per-user secret keys. Your
            deposit address is derived from an operator-controlled master seed; the ledger is the source of truth for
            what you own.</p>
          </div>
        </section>

        {/* ESCROW */}
        <section id="escrow" className="docs__sec">
          <h2 className="docs__h2"><Shield width={22} height={22} /> Escrow & settlement</h2>
          <p>
            Winning doesn’t hand your money straight to the seller. The winning bid is captured into <b>escrow</b> and
            only released once the card actually reaches you. Every order walks a clear state machine:
          </p>
          <div className="docs__lifecycle">
            {[
              ['Locked', 'Bid captured into escrow the moment you win.'],
              ['Shipped', 'Seller ships and adds tracking.'],
              ['Delivered', 'Carrier confirms the card arrived.'],
              ['Released', 'Dispute window passes → funds pay out.'],
            ].map(([t, d], i) => (
              <div key={t} className="docs__lc">
                <div className="docs__lc-top"><span className="docs__lc-dot">{i + 1}</span>{i < 3 && <span className="docs__lc-line" />}</div>
                <b>{t}</b>
                <p className="muted">{d}</p>
              </div>
            ))}
          </div>
          <ul className="docs__ul">
            <li><b>Buyer protection.</b> Funds are locked in escrow — the seller is only paid after delivery and a short dispute window.</li>
            <li><b>Didn’t ship?</b> If a seller never ships within the deadline, the order auto-cancels and you’re refunded <b>100%</b>.</li>
            <li><b>Something wrong?</b> Open a dispute inside the window; it resolves to either a release to the seller or a full refund to you.</li>
            <li><b>Refunds carry no fee.</b> The 5% is only ever taken on a successful release — a refund returns the entire amount.</li>
          </ul>
        </section>

        {/* SHIPPING */}
        <section id="shipping" className="docs__sec">
          <h2 className="docs__h2"><Truck width={22} height={22} /> Shipping &amp; delivery</h2>
          <p>
            Win a card and it lands in <b>Ready to ship</b>. The buyer pays shipping (not the seller),
            and only when you choose to send items your way — so you can let wins pile up and pay once.
            Cost is based on the seller’s location and the item’s weight, to your saved address.
          </p>
          <div className="docs__cards3">
            <div className="docs__mini card">
              <span className="docs__mini-ic"><Truck width={18} height={18} /></span>
              <h3>Standard</h3>
              <p className="muted">Ship a card whenever you like and pay that package’s shipping.</p>
            </div>
            <div className="docs__mini card">
              <span className="docs__mini-ic"><Gift width={18} height={18} /></span>
              <h3>Weekly bundling</h3>
              <p className="muted">Where a seller offers it, pay shipping once a week — that week’s wins ship together.</p>
            </div>
            <div className="docs__mini card">
              <span className="docs__mini-ic"><Shield width={18} height={18} /></span>
              <h3>Private &amp; secure</h3>
              <p className="muted">Hide your address — the seller ships to BIDit and we forward it to you.</p>
            </div>
          </div>
          <ul className="docs__ul">
            <li><b>Buy now, ship later.</b> Let wins sit in Ready to ship (held up to 7 days), then pick which to send and pay shipping once. Don’t want one? Discard it.</li>
            <li><b>One package per seller.</b> Bundling and ship-later group a single seller’s items into one shipment with one shipping charge.</li>
            <li><b>Delivery.</b> The seller adds tracking and marks it shipped — then you tap <b>Confirm received</b> when it arrives.</li>
            <li><b>Set your address first.</b> Add it under Payments &amp; Shipping so we can quote and label correctly.</li>
          </ul>
        </section>

        {/* FEES */}
        <section id="fees" className="docs__sec">
          <h2 className="docs__h2"><Tag width={22} height={22} /> Fees</h2>
          <p>BIDit’s fee is simple: <b>5% of a shipped sale</b>, taken only when escrow releases to the seller.</p>
          <div className="card docs__split">
            <div className="split__bar">
              <span className="split__seller" style={{ width: '95%' }}>95% seller</span>
              <span className="split__fee" style={{ width: '5%' }}>5%</span>
            </div>
            <div className="docs__split-legend">
              <span><i className="docs__sw docs__sw--seller" /> <b>95%</b> — paid to the seller in USDC</span>
              <span><i className="docs__sw docs__sw--fee" /> <b>5%</b> — buys back <b className="accent">$BID</b> on-chain</span>
            </div>
          </div>
          <ul className="docs__ul">
            <li><b>Buyers pay no platform fee.</b> You pay your winning bid — nothing on top.</li>
            <li><b>The fee is success-based.</b> No sale, no ship, no fee. It’s only deducted on release.</li>
            <li><b>The 5% isn’t pocketed</b> — it goes straight into the $BID buyback below, which every holder benefits from.</li>
          </ul>
        </section>

        {/* TOKENOMICS */}
        <section id="tokenomics" className="docs__sec">
          <h2 className="docs__h2"><Gift width={22} height={22} /> $BID tokenomics</h2>
          <p>
            <b className="accent">$BID</b> is the platform token, and its core mechanic is a <b>buyback flywheel</b>:
            real marketplace activity turns into steady on-chain buy pressure. The pitch is one line —
            <b> every card that ships pumps the token.</b>
          </p>
          <div className="docs__fly">
            {[
              ['Bid & win', 'A buyer wins a live auction and pays in USDC.'],
              ['Card ships', 'The seller ships; escrow releases on delivery.'],
              ['5% buys $BID', 'The 5% fee is used to buy back $BID on-chain.'],
              ['Everyone benefits', 'More sales → more buybacks → stronger token.'],
            ].map(([t, d], i) => (
              <div key={t} className="docs__fly-step card">
                <span className="docs__fly-n">{i + 1}</span>
                <b>{t}</b>
                <p className="muted">{d}</p>
              </div>
            ))}
          </div>
          <ul className="docs__ul">
            <li><b>Fee-funded, not inflationary.</b> Buybacks are paid from real revenue (the 5%), not by minting new supply.</li>
            <li><b>On-chain & auditable.</b> Buyback spends are recorded so the flywheel is transparent, not a promise.</li>
            <li><b>Volume-linked.</b> The more real cards move through BIDit, the more $BID gets bought back.</li>
          </ul>
          <div className="docs__note">
            <Info width={18} height={18} />
            <p>BIDit is in <b>beta on Solana devnet</b>. Balances and buybacks run against test USDC while the flow is
            hardened; the live-token DEX swap turns on with mainnet. Nothing here is investment advice.</p>
          </div>
        </section>

        {/* RANDOMIZER */}
        <section id="randomizer" className="docs__sec">
          <h2 className="docs__h2"><Dice width={22} height={22} /> The randomizer</h2>
          <p>
            Some listings aren’t a single card — they’re a <b>randomizer</b> (a “bid to win a roll”). You bid on the
            spot, and the winner triggers a spin that lands on one prize from the seller’s pool.
          </p>
          <ul className="docs__ul">
            <li><b>Bid to win the roll.</b> The auction runs like any other; the highest bidder wins the spin.</li>
            <li><b>Server decides, everyone sees the same spin.</b> On close, the server picks the landing slot and
            broadcasts the reel, so the seller and every viewer watch the identical decelerating roll in sync.</li>
            <li><b>Weighted &amp; tiered.</b> Sellers set prizes with tiers and weights (a chase hits less often than a
            pack) — shown as colored tiers on the reel.</li>
            <li><b>Provably fair.</b> Each spin is driven by a hashed random seed, so the outcome can’t be tampered with
            after bids are in.</li>
          </ul>
        </section>

        {/* SELLING */}
        <section id="selling" className="docs__sec">
          <h2 className="docs__h2"><UserCheck width={22} height={22} /> Selling on BIDit</h2>
          <p>Running auctions takes a couple of minutes to set up:</p>
          <ol className="docs__steps">
            <li><span className="docs__step-n">1</span><div><b>Become a seller</b><p className="muted">Apply from your dashboard. In beta, sellers are auto-approved; KYC verification arrives with mainnet.</p></div></li>
            <li><span className="docs__step-n">2</span><div><b>Link your pump.fun coin</b><p className="muted">Connect the coin/stream you broadcast on so the overlay knows which page to appear on for your viewers.</p></div></li>
            <li><span className="docs__step-n">3</span><div><b>Build your listings</b><p className="muted">Add a single card, or add a <b>randomizer</b> with a weighted prize pool — the two are separate create flows in your Listings.</p></div></li>
            <li><span className="docs__step-n">4</span><div><b>Go live & run auctions</b><p className="muted">Start an auction from your queue; watch bids roll in on the <Link to="/seller/live">Live monitor</Link>.</p></div></li>
            <li><span className="docs__step-n">5</span><div><b>Ship & get paid</b><p className="muted">Mark orders shipped with tracking. On delivery, escrow releases 95% to you in USDC — payouts and the split live under <Link to="/seller/payouts">Payouts</Link>.</p></div></li>
          </ol>
          <Link className="btn btn-primary" to="/seller">Open the Seller Studio <ArrowRight width={17} height={17} /></Link>
        </section>

        {/* SAFETY */}
        <section id="safety" className="docs__sec">
          <h2 className="docs__h2"><Info width={22} height={22} /> Safety & trust</h2>
          <ul className="docs__ul">
            <li><b>Server-authoritative.</b> Every bid, hold, and payout is validated and recorded server-side on a double-entry ledger — the client can’t fake a balance or a win.</li>
            <li><b>Escrow by default.</b> Buyer funds are never handed to a seller before the card is delivered.</li>
            <li><b>No keys, ever.</b> BIDit never asks for your private key. Deposits go to an address; the ledger tracks your balance.</li>
            <li><b>Beta &amp; devnet.</b> The platform currently runs on Solana devnet with test USDC. Mainnet is gated behind a security audit, hardened key custody, an on-chain escrow program, and KYC/AML.</li>
          </ul>
        </section>

        {/* FAQ */}
        <section id="faq" className="docs__sec">
          <h2 className="docs__h2"><Book width={22} height={22} /> FAQ</h2>
          <div className="docs__faq">
            {[
              ['Do I need a crypto wallet to bid?', 'You need somewhere to send USDC from. Once your BIDit balance is funded you bid from that balance — no wallet pop-up per bid.'],
              ['What happens to my money if I get outbid?', 'The hold on your bid releases back to your available balance instantly, ready for your next bid or a withdrawal.'],
              ['When does the seller actually get paid?', 'Not at win — the winning bid sits in escrow and only releases (95% to the seller) after the card is delivered and the dispute window passes.'],
              ['What if the card never arrives?', 'If a seller doesn’t ship in time the order auto-cancels and you’re refunded 100%. You can also open a dispute within the window.'],
              ['Is there a fee for buyers?', 'No. Buyers pay only their winning bid. The 5% fee comes out of the seller’s side on shipped sales and funds the $BID buyback.'],
              ['Is this real money right now?', 'It’s live on Solana devnet with test USDC during beta. Real-money mainnet turns on after audit, key custody, and compliance work.'],
            ].map(([q, a]) => (
              <details key={q} className="docs__q">
                <summary>{q}</summary>
                <p className="muted">{a}</p>
              </details>
            ))}
          </div>
          <div className="docs__cta card">
            <div>
              <b>Still have questions?</b>
              <p className="muted">Follow along and reach us on X.</p>
            </div>
            <a className="btn btn-ghost" href="https://x.com/biditsol" target="_blank" rel="noreferrer">@biditsol <ArrowRight width={16} height={16} /></a>
          </div>
        </section>
      </article>
    </main>
  );
}
