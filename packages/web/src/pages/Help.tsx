import { Link } from 'react-router-dom';
import {
  Wallet, Radio, Bolt, Truck, UserCheck, Tag, Book, Shield, Gift, ArrowRight, XLogo,
} from '../icons';

const BUYER = [
  { icon: Wallet, title: 'Add funds', body: 'Deposit USDC to your BIDit wallet — it takes a minute and you only do it once.', to: '/deposit', cta: 'Go to Deposit' },
  { icon: Radio, title: 'Find a live auction', body: 'Browse “Live right now” on the homepage, or open a seller’s coin to watch and bid.', to: '/', cta: 'Browse live' },
  { icon: Bolt, title: 'Bid in real time', body: 'Tap to bid. Your funds are only reserved — you’re not charged unless you actually win.', to: '/docs#how', cta: 'How bidding works' },
  { icon: Truck, title: 'Win → ship it', body: 'Won cards land in “Ready to ship.” Bundle a seller’s wins to pay shipping just once.', to: '/ship', cta: 'Ready to ship' },
];

const SELLER = [
  { icon: UserCheck, title: 'Apply to sell', body: 'Set up a seller account and connect the pump.fun coin you stream on.', to: '/seller', cta: 'Become a seller' },
  { icon: Tag, title: 'List your cards', body: 'Add items with a photo, starting bid and weight so shipping quotes are accurate.', to: '/seller/listings', cta: 'Your listings' },
  { icon: Radio, title: 'Go live', body: 'Run live auctions and randomizer wheels straight on your stream.', to: '/seller/live', cta: 'Go live' },
  { icon: Truck, title: 'Fulfill', body: 'When a buyer pays shipping, pack the card, add tracking, and mark it shipped.', to: '/seller/shipments', cta: 'Shipments' },
];

const GUIDES = [
  { icon: Bolt, label: 'How bidding works', to: '/docs#how' },
  { icon: Wallet, label: 'Deposits & withdrawals', to: '/docs#balance' },
  { icon: Truck, label: 'Shipping & delivery', to: '/docs#shipping' },
  { icon: Tag, label: 'Fees & $BID', to: '/docs#fees' },
  { icon: UserCheck, label: 'Selling on BIDit', to: '/docs#selling' },
  { icon: Shield, label: 'Safety & trust', to: '/docs#safety' },
];

function Track({ kicker, steps }: { kicker: string; steps: typeof BUYER }) {
  return (
    <div className="qs__track">
      <h2 className="qs__kicker">{kicker}</h2>
      <div className="qs__steps">
        {steps.map((s, i) => (
          <Link key={s.title} to={s.to} className="qs__step card">
            <span className="qs__n">{i + 1}</span>
            <span className="qs__ic"><s.icon width={20} height={20} /></span>
            <div className="qs__meta">
              <b>{s.title}</b>
              <span className="muted">{s.body}</span>
              <span className="qs__cta">{s.cta} <ArrowRight width={14} height={14} /></span>
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}

export default function Help() {
  return (
    <main className="container help">
      <header className="help__hero">
        <span className="hero__tag"><span className="dot" /> Help &amp; quick start</span>
        <h1 className="display help__h1">Everything you need to get going.</h1>
        <p className="help__lead">New to BIDit? Follow the steps below. Want the full picture — escrow, fees, the $BID flywheel — the <Link to="/docs" className="accent">docs</Link> cover it all.</p>
      </header>

      <div className="qs">
        <Track kicker="For buyers" steps={BUYER} />
        <Track kicker="For sellers" steps={SELLER} />
      </div>

      <section className="help__guides">
        <h2 className="qs__kicker"><Book width={18} height={18} /> Guides</h2>
        <div className="help__guidegrid">
          {GUIDES.map((g) => (
            <Link key={g.label} to={g.to} className="help__guide card">
              <g.icon width={18} height={18} /> <span>{g.label}</span> <ArrowRight width={15} height={15} className="help__guidearr" />
            </Link>
          ))}
        </div>
      </section>

      <section className="help__contact card">
        <span className="help__contact-ic"><Gift width={22} height={22} /></span>
        <div>
          <h3 className="acct-sub" style={{ marginBottom: 4 }}>Still stuck?</h3>
          <p className="muted">DM us on X and we’ll help you out — fast during the beta.</p>
        </div>
        <a className="btn btn-primary" href="https://x.com/biditsol" target="_blank" rel="noreferrer"><XLogo width={16} height={16} /> Message @biditsol</a>
      </section>
    </main>
  );
}
