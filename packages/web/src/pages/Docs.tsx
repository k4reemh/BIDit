import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Grid, Radio, Eye, Wallet, Shield, Tag, Gift, Dice, UserCheck, Info, Book, ArrowRight, Truck,
} from '../icons';

const SECTIONS = [
  { id: 'overview', label: 'What is BIDit', icon: Grid },
  { id: 'how', label: 'How an auction works', icon: Radio },
  { id: 'watch', label: 'Where to watch and bid', icon: Eye },
  { id: 'balance', label: 'Balance & deposits', icon: Wallet },
  { id: 'escrow', label: 'Escrow & settlement', icon: Shield },
  { id: 'shipping', label: 'Shipping & delivery', icon: Truck },
  { id: 'fees', label: 'Fees', icon: Tag },
  { id: 'tokenomics', label: '$BID tokenomics', icon: Gift },
  { id: 'points', label: 'BIDit Points & airdrops', icon: Gift },
  { id: 'randomizer', label: 'The randomizer', icon: Dice },
  { id: 'selling', label: 'Selling on BIDit', icon: UserCheck },
  { id: 'safety', label: 'Safety & trust', icon: Info },
  { id: 'faq', label: 'FAQ', icon: Book },
];

export default function Docs() {
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
          <span className="hero__tag"><span className="dot" /> Docs · Live on Solana mainnet</span>
          <h1 className="display docs__h1">How BIDit works</h1>
          <p className="docs__lead">
            BIDit turns a live pump.fun stream into a real-time auction house. Sellers run live auctions
            straight on their stream, bidders bid in <b>USDC</b> from a funded balance, items are held
            until they ship, and <b>4% of every shipped sale</b> buys back <b className="accent">$BID</b> on-chain.
            This page explains the whole loop end to end.
          </p>
        </header>

        {/* OVERVIEW */}
        <section id="overview" className="docs__sec">
          <h2 className="docs__h2"><Grid width={22} height={22} /> What is BIDit</h2>
          <p>
            BIDit is <b>“Whatnot for degens.”</b> A seller goes live on pump.fun to show off anything: cards, fashion,
            sneakers, tech, collectibles. Their stream plays on the BIDit watch page with a live auction panel next to
            it. Viewers place bids in real time, the highest bidder when the clock hits zero wins, and the item ships to
            them. Money moves in USDC. No chat comments, no manual invoicing, no “DM me to pay.”
          </p>
          <div className="docs__cards3">
            <div className="docs__mini card">
              <span className="docs__mini-ic"><Radio width={18} height={18} /></span>
              <b>Live, on the stream</b>
              <p className="muted">The seller’s pump.fun stream and the auction run side by side on one page.</p>
            </div>
            <div className="docs__mini card">
              <span className="docs__mini-ic"><Wallet width={18} height={18} /></span>
              <b>Settled in USDC</b>
              <p className="muted">You fund a balance once and bid instantly. Winning captures your bid into escrow.</p>
            </div>
            <div className="docs__mini card">
              <span className="docs__mini-ic"><Gift width={18} height={18} /></span>
              <b>Every ship pumps $BID</b>
              <p className="muted">4% of each shipped sale routes to an on-chain $BID buyback. That’s the flywheel.</p>
            </div>
          </div>
          <div className="docs__note">
            <Info width={18} height={18} />
            <p><b>Core principle:</b> the server is authoritative. The app only renders state. Every bid,
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
                <p className="muted">The seller queues an item, then hits “Start auction” on their stream. It appears
                for every viewer at once with the photo, title, and a starting bid.</p>
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
                chance to answer. The timer can never sit more than ~5 seconds out. No last-millisecond steals.</p>
              </div>
            </li>
            <li>
              <span className="docs__step-n">4</span>
              <div>
                <b>Highest bid at zero wins</b>
                <p className="muted">When the clock ends, the top bidder wins. Their held bid is <b>captured into
                escrow</b>. Everyone else’s holds are released back to their balance.</p>
              </div>
            </li>
            <li>
              <span className="docs__step-n">5</span>
              <div>
                <b>Ship → settle</b>
                <p className="muted">The seller ships the item. Once it’s delivered and the dispute window passes,
                escrow releases: 95% to the seller, 4% to the $BID buyback, 1% to the community treasury.</p>
              </div>
            </li>
          </ol>
        </section>

        {/* WATCH AND BID */}
        <section id="watch" className="docs__sec">
          <h2 className="docs__h2"><Eye width={22} height={22} /> Where to watch and bid</h2>
          <p>
            Everything happens on the BIDit site. There is nothing to install: the seller’s pump.fun stream plays inside
            the BIDit watch page, with the auction panel beside it. It works the same on desktop and mobile.
          </p>
          <ol className="docs__steps">
            <li>
              <span className="docs__step-n">1</span>
              <div>
                <b>Sign in and fund your balance</b>
                <p className="muted">Create an account and deposit USDC (see
                <a href="#balance"> Balance &amp; deposits</a>). You bid from that balance, so there is no wallet
                pop-up on every bid.</p>
              </div>
            </li>
            <li>
              <span className="docs__step-n">2</span>
              <div>
                <b>Open a live seller</b>
                <p className="muted">Pick a stream from <Link to="/">Live right now</Link> on the homepage, or filter by
                category on <Link to="/browse">Browse</Link>. That opens the watch page with the stream and the bid
                panel side by side.</p>
              </div>
            </li>
            <li>
              <span className="docs__step-n">3</span>
              <div>
                <b>Bid</b>
                <p className="muted">The panel shows the current bid, the countdown, who is leading, and a live feed.
                Press bid to take the next increment, or wait and answer late. Theatre mode gives the stream more room
                while keeping the panel in reach.</p>
              </div>
            </li>
            <li>
              <span className="docs__step-n">4</span>
              <div>
                <b>Win</b>
                <p className="muted">If you are on top at zero, a full-screen celebration fires and the item lands in
                your <Link to="/purchases">Purchases</Link>, ready to ship.</p>
              </div>
            </li>
          </ol>
          <div className="docs__note">
            <Info width={18} height={18} />
            <p>Sellers run their side from the dashboard: start auctions and watch bids land on
            <Link to="/seller/live"> Seller → Live</Link>, which mirrors what viewers see.</p>
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
            <div className="docs__deflow-step"><b>Deposit</b><p className="muted">Send <b>USDC only</b> to your deposit address. BIDit detects it on-chain, sweeps it into the BIDit treasury wallet, and credits your balance.</p></div>
            <ArrowRight className="docs__deflow-arrow" width={18} height={18} />
            <div className="docs__deflow-step"><b>Bid</b><p className="muted">A live bid <b>holds</b> that amount. Held funds sit in your balance but can’t be spent twice. Get outbid and they release.</p></div>
            <ArrowRight className="docs__deflow-arrow" width={18} height={18} />
            <div className="docs__deflow-step"><b>Withdraw</b><p className="muted">Any available (un-held) balance can be withdrawn to a Solana address at any time. There is no lock-up.</p></div>
          </div>
          <p className="muted docs__afterflow">
            Your deposit address is an inbox, not a wallet you keep funds in. Anything that lands there is swept into the
            BIDit treasury within about a minute and shows up as balance on your account, so the address itself always
            reads empty. Your balance is the record of what you own, and you can withdraw it whenever you like.
          </p>
          <div className="docs__note">
            <Shield width={18} height={18} />
            <p><b>Send USDC on Solana, nothing else.</b> Your deposit address takes USDC (SPL) on Solana. Any other token
            or another network sent to it can’t be credited and may be lost. You never need SOL for gas: BIDit pays the
            network fees on deposits and withdrawals.</p>
          </div>
          <p className="muted docs__afterflow">
            The dashboard splits your balance into <b>Available</b> (free to bid or withdraw) and <b>Held in active
            bids</b> (committed to auctions you’re currently leading). Your address, live balance and the withdraw form
            are all under <Link to="/deposit">Account → Deposit &amp; Withdraw</Link>.
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
            <li><b>Buyer protection.</b> Funds are locked in escrow. The seller is only paid after delivery and a short dispute window.</li>
            <li><b>Didn’t ship?</b> If a seller never ships within the deadline, the order auto-cancels and you’re refunded <b>100%</b>.</li>
            <li><b>Something wrong?</b> Open a dispute inside the window; it resolves to either a release to the seller or a full refund to you.</li>
            <li><b>Refunds carry no fee.</b> The fee is only ever taken on a successful release. A refund returns the entire amount.</li>
          </ul>
        </section>

        {/* SHIPPING */}
        <section id="shipping" className="docs__sec">
          <h2 className="docs__h2"><Truck width={22} height={22} /> Shipping &amp; delivery</h2>
          <p>
            Win an item and it lands in <b>Ready to ship</b>. The buyer pays shipping (not the seller),
            and only when you choose to send items your way, so you can let wins pile up and pay once.
            Cost is based on the seller’s location and the item’s weight, to your saved address.
          </p>
          <div className="docs__cards3">
            <div className="docs__mini card">
              <span className="docs__mini-ic"><Truck width={18} height={18} /></span>
              <h3>Standard</h3>
              <p className="muted">Ship an item whenever you like and pay that package’s shipping.</p>
            </div>
            <div className="docs__mini card">
              <span className="docs__mini-ic"><Gift width={18} height={18} /></span>
              <h3>Weekly bundling</h3>
              <p className="muted">Where a seller offers it, pay shipping once a week. That week’s wins ship together.</p>
            </div>
            <div className="docs__mini card">
              <span className="docs__mini-ic"><Shield width={18} height={18} /></span>
              <h3>Private &amp; secure</h3>
              <p className="muted">Hide your address. The seller ships to BIDit and we forward it to you.</p>
            </div>
          </div>
          <ul className="docs__ul">
            <li><b>Buy now, ship later.</b> Let wins sit in Ready to ship (held up to 14 days), then pick which to send and pay shipping once. Don’t want one? Discard it.</li>
            <li><b>The 14-day window.</b> Pay shipping within 14 days of the purchase. Discarding an item, or letting the window pass, forfeits it: the seller keeps the item and the sale still pays out to them.</li>
            <li><b>One package per seller.</b> Bundling and ship-later group a single seller’s items into one shipment with one shipping charge.</li>
            <li><b>BIDit buys the label.</b> Once you pay shipping, the seller confirms the box size and BIDit generates and pays for the carrier label. The seller prints it and drops the package off, so tracking always comes from the carrier rather than the seller’s word.</li>
            <li><b>Delivery.</b> Carrier scans move the order to delivered. When it arrives, tap <b>Confirm received</b> to release escrow early, or let the dispute window run out on its own.</li>
            <li><b>Set your address first.</b> Add it under Payments &amp; Shipping so we can quote and label correctly.</li>
          </ul>
        </section>

        {/* FEES */}
        <section id="fees" className="docs__sec">
          <h2 className="docs__h2"><Tag width={22} height={22} /> Fees</h2>
          <p>BIDit’s fee is simple: <b>5% of a shipped sale</b>, taken only when escrow releases to the seller. It splits into a <b>4% $BID buyback</b> and <b>1% to a community treasury</b> for buyer protection.</p>
          <div className="card docs__split">
            <div className="split__bar">
              <span className="split__seller" style={{ width: '95%' }}>95% seller</span>
              <span className="split__fee" style={{ width: '5%' }}>5%</span>
            </div>
            <div className="docs__split-legend">
              <span><i className="docs__sw docs__sw--seller" /> <b>95%</b> paid to the seller in USDC</span>
              <span><i className="docs__sw docs__sw--fee" /> <b>4%</b> buys back <b className="accent">$BID</b> on-chain</span>
              <span><i className="docs__sw docs__sw--fee" /> <b>1%</b> to the community treasury for buyer protection</span>
            </div>
          </div>
          <ul className="docs__ul">
            <li><b>Buyers pay no platform fee.</b> You pay your winning bid, nothing on top.</li>
            <li><b>The fee is success-based.</b> No sale, no ship, no fee. It’s only deducted on release.</li>
            <li><b>Nothing is pocketed.</b> 4% goes straight into the $BID buyback below, and 1% funds a community treasury that backs buyer protection.</li>
          </ul>
        </section>

        {/* TOKENOMICS */}
        <section id="tokenomics" className="docs__sec">
          <h2 className="docs__h2"><Gift width={22} height={22} /> $BID tokenomics</h2>
          <p>
            <b className="accent">$BID</b> is the platform token, and its core mechanic is a <b>buyback flywheel</b>:
            real marketplace activity turns into steady on-chain buy pressure. The pitch is one line:
            <b> every item that ships pumps the token.</b>
          </p>
          <div className="docs__fly">
            {[
              ['Bid & win', 'A buyer wins a live auction and pays in USDC.'],
              ['Item ships', 'The seller ships; escrow releases on delivery.'],
              ['4% buys $BID', 'The 4% buyback portion of the fee buys back $BID on-chain.'],
              ['The flywheel spins', 'More sales → more buybacks → stronger token.'],
            ].map(([t, d], i) => (
              <div key={t} className="docs__fly-step card">
                <span className="docs__fly-n">{i + 1}</span>
                <b>{t}</b>
                <p className="muted">{d}</p>
              </div>
            ))}
          </div>
          <ul className="docs__ul">
            <li><b>Fee-funded, not inflationary.</b> Buybacks are paid from real revenue (the 4% buyback), not by minting new supply.</li>
            <li><b>On-chain & auditable.</b> Buyback spends are recorded so the flywheel is transparent, not a promise.</li>
            <li><b>Volume-linked.</b> The more real items move through BIDit, the more $BID gets bought back.</li>
            <li><b>5% locked for the community.</b> At launch, 5% of $BID supply is locked in a community reserve and
            distributed as airdrops to platform users, allocated by <a href="#points">BIDit Points</a>. The first
            airdrop lands <b>1 month after launch</b>, the next <b>3 months after launch</b>.</li>
          </ul>
          <div className="docs__note">
            <Info width={18} height={18} />
            <p>BIDit runs on <b>Solana mainnet with real USDC</b>. Buyback amounts accrue from live sales and are
            recorded on the ledger; the on-chain DEX swap that spends that pool is being rolled out. Nothing here is
            investment advice.</p>
          </div>
        </section>

        {/* POINTS */}
        <section id="points" className="docs__sec">
          <h2 className="docs__h2"><Gift width={22} height={22} /> BIDit Points &amp; airdrops</h2>
          <p>
            <b className="accent">BIDit Points</b> reward the people who actually use the platform. The more you buy and
            sell, the more points you stack. Points decide your share of the <b>$BID community airdrops</b> funded
            by the 5% reserve locked at launch.
          </p>
          <div className="docs__fly">
            {[
              ['Buyers earn 100×', 'Every $1 you spend on wins or store buys earns 100 points. Win a $10 auction → 1,000 points, automatically.'],
              ['Sellers earn 20×', 'Every $1 you sell earns 20 points. Sell $1,000 on stream → 20,000 points across those sales.'],
              ['Claim bonus missions', 'One-time bonuses for firsts: deposits, bids, wins, sales. Complete them and press claim.'],
              ['Catch the airdrops', 'Airdrop #1 lands 1 month after launch; the next follows 3 months after. Your share scales with your points.'],
            ].map(([t, d], i) => (
              <div key={t} className="docs__fly-step card">
                <span className="docs__fly-n">{i + 1}</span>
                <b>{t}</b>
                <p className="muted">{d}</p>
              </div>
            ))}
          </div>
          <p style={{ marginTop: 18 }}><b>Point bonuses</b> are one-time missions you claim from your <Link to="/points">BIDit Points</Link> page:</p>
          <ul className="docs__ul">
            <li><b>+1,000</b>: Deposit USDC into your BIDit wallet.</li>
            <li><b>+1,000</b>: Place your first bid.</li>
            <li><b>+3,000</b>: Win your first auction.</li>
            <li><b>+1,000</b>: Win a live giveaway.</li>
            <li><b>+5,000</b>: Refer a friend who purchases an item <i>(coming soon)</i>.</li>
            <li><b>+3,000</b>: Sell and fulfill your first item on BIDit.</li>
            <li><b>+3,000</b>: Sell and fulfill 10 items.</li>
            <li><b>+10,000</b>: Become a Verified Seller (fulfill 10 orders).</li>
          </ul>
          <p>
            See where you stand on the <Link to="/leaderboard">Points Leaderboard</Link>.
          </p>
          <div className="docs__note">
            <Info width={18} height={18} />
            <p>Points are a loyalty score for community airdrops and prizes. They are <b>not</b> a currency, a deposit,
            or an investment, and they can’t be bought, transferred or withdrawn.</p>
          </div>
        </section>

        {/* RANDOMIZER */}
        <section id="randomizer" className="docs__sec">
          <h2 className="docs__h2"><Dice width={22} height={22} /> The randomizer</h2>
          <p>
            Some listings aren’t a single card: they’re a <b>randomizer</b> (a “bid to win a roll”). You bid on the
            spot, and the winner triggers a spin that lands on one prize from the seller’s pool.
          </p>
          <ul className="docs__ul">
            <li><b>Bid to win the roll.</b> The auction runs like any other; the highest bidder wins the spin.</li>
            <li><b>Server decides, everyone sees the same spin.</b> On close, the server picks the landing slot and
            broadcasts the reel, so the seller and every viewer watch the identical decelerating roll in sync.</li>
            <li><b>Weighted &amp; tiered.</b> Sellers set prizes with tiers and weights (a chase hits less often than a
            pack), shown as colored tiers on the reel.</li>
            <li><b>Provably fair.</b> Each spin is driven by a hashed random seed, so the outcome can’t be tampered with
            after bids are in.</li>
          </ul>
        </section>

        {/* SELLING */}
        <section id="selling" className="docs__sec">
          <h2 className="docs__h2"><UserCheck width={22} height={22} /> Selling on BIDit</h2>
          <p>Setup takes a couple of minutes:</p>
          <ol className="docs__steps">
            <li><span className="docs__step-n">1</span><div><b>Become a seller</b><p className="muted">Apply from your dashboard. Sellers are approved automatically today, and start out unverified: fulfil 10 orders to earn the Verified badge. Formal KYC arrives as volume grows.</p></div></li>
            <li><span className="docs__step-n">2</span><div><b>Link your pump.fun coin</b><p className="muted">Connect the coin you stream on, or let BIDit create one for you. That coin is what points viewers at your watch page.</p></div></li>
            <li><span className="docs__step-n">3</span><div><b>Build your listings</b><p className="muted">Add a single card, or add a <b>randomizer</b> with a weighted prize pool. The two are separate create flows in your Listings.</p></div></li>
            <li><span className="docs__step-n">4</span><div><b>Go live & run auctions</b><p className="muted">Start an auction from your queue; watch bids roll in on the <Link to="/seller/live">Live monitor</Link>.</p></div></li>
            <li><span className="docs__step-n">5</span><div><b>Ship & get paid</b><p className="muted">Confirm the package size, print the label BIDit buys for you, and drop it off. On delivery, escrow releases 95% to you in USDC. Payouts and the split live under <Link to="/seller/payouts">Payouts</Link>.</p></div></li>
          </ol>
          <Link className="btn btn-primary" to="/seller">Open the Seller Studio <ArrowRight width={17} height={17} /></Link>
        </section>

        {/* SAFETY */}
        <section id="safety" className="docs__sec">
          <h2 className="docs__h2"><Info width={22} height={22} /> Safety & trust</h2>
          <ul className="docs__ul">
            <li><b>Server-authoritative.</b> Every bid, hold, and payout is validated and recorded server-side on a double-entry ledger. The client can’t fake a balance or a win.</li>
            <li><b>Escrow by default.</b> Buyer funds are never handed to a seller before the card is delivered.</li>
            <li><b>No keys, ever.</b> BIDit never asks for your private key. Deposits go to an address; the ledger tracks your balance.</li>
            <li><b>Real money, early platform.</b> BIDit runs on Solana mainnet and every balance is real USDC. Custody is currently operator-held: BIDit controls the treasury and escrow wallets, so you are trusting the platform the way you would any custodial marketplace. A non-custodial on-chain escrow program and third-party audit are the next milestones. Withdrawals are capped at $1,000 per day per account while the payout path is hardened.</li>
          </ul>
        </section>

        {/* FAQ */}
        <section id="faq" className="docs__sec">
          <h2 className="docs__h2"><Book width={22} height={22} /> FAQ</h2>
          <div className="docs__faq">
            {[
              ['Do I need a crypto wallet to bid?', 'You need somewhere to send USDC from. Once your BIDit balance is funded you bid from that balance. No wallet pop-up per bid.'],
              ['What happens to my money if I get outbid?', 'The hold on your bid releases back to your available balance instantly, ready for your next bid or a withdrawal.'],
              ['When does the seller actually get paid?', 'Not when you win. The winning bid sits in escrow and only releases (95% to the seller) after the item is delivered and the dispute window passes.'],
              ['What if the seller never ships?', 'You get a 100% refund. Once you have paid shipping the seller has 7 days to send it; miss that and the order cancels itself and the full item price returns to your balance. You can also open a dispute inside the window after delivery.'],
              ['Is there a fee for buyers?', 'No. Buyers pay only their winning bid. The 5% fee comes out of the seller’s side on shipped sales: 4% funds the $BID buyback and 1% a community treasury for buyer protection.'],
              ['Is this real money?', 'Yes. BIDit runs on Solana mainnet and every balance is real USDC. Deposits, bids, payouts and withdrawals all move real funds, so treat your balance the way you would any exchange balance.'],
              ['Do I need SOL for gas?', 'No. BIDit pays the network fees on both deposits and withdrawals. You only ever need USDC.'],
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
