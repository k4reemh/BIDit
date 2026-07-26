import { Link } from 'react-router-dom';
import Logo from './Logo';
import { XLogo, GitHub } from '../icons';
import { CATEGORIES } from '../data';

/** Every footer link goes somewhere real — no placeholder columns. */
const COLS: { h: string; links: { label: string; to?: string; href?: string }[] }[] = [
  {
    h: 'Marketplace',
    links: [
      { label: 'Live now', to: '/' },
      { label: 'Browse streams', to: '/browse' },
      { label: 'Leaderboard', to: '/leaderboard' },
      { label: 'Sell on BIDit', to: '/seller' },
    ],
  },
  {
    h: 'Categories',
    links: CATEGORIES.slice(0, 4).map((c) => ({ label: c.name, to: `/browse?cat=${encodeURIComponent(c.name)}` })),
  },
  {
    h: 'Resources',
    links: [
      { label: 'Help & quick start', to: '/help' },
      { label: 'Docs', to: '/docs' },
      { label: '$BID token', to: '/docs#tokenomics' },
      { label: 'Shipping policy', to: '/docs#shipping' },
    ],
  },
  {
    h: 'Community',
    links: [
      { label: 'BIDit Points', to: '/points' },
      { label: 'X / Twitter', href: 'https://x.com/biditsol' },
      { label: 'GitHub', href: 'https://github.com/k4reemh/BIDit1' },
    ],
  },
];

export default function Footer() {
  return (
    <footer className="footer">
      <div className="container footer__top">
        <div className="footer__brand">
          <Logo size={30} />
          <p className="muted">Live auctions on pump.fun streams, settled in USDC. 4% of every sale buys back $BID.</p>
          <div className="footer__social">
            <a className="icon-btn" href="https://x.com/biditsol" target="_blank" rel="noreferrer" aria-label="BIDit on X"><XLogo width={18} height={18} /></a>
            <a className="icon-btn" href="https://github.com/k4reemh/BIDit1" target="_blank" rel="noreferrer" aria-label="BIDit on GitHub"><GitHub width={18} height={18} /></a>
          </div>
        </div>
        <div className="footer__cols">
          {COLS.map((c) => (
            <div key={c.h} className="footer__col">
              <h4>{c.h}</h4>
              {c.links.map((l) =>
                l.href
                  ? <a key={l.label} href={l.href} target="_blank" rel="noreferrer">{l.label}</a>
                  : <Link key={l.label} to={l.to!}>{l.label}</Link>,
              )}
            </div>
          ))}
        </div>
      </div>
      <div className="container footer__bar">
        <span className="muted">© 2026 BIDit. All rights reserved.</span>
        <span className="footer__chips">
          <span className="pill">◎ Built on Solana</span>
          <span className="pill"><span className="dot" /> Beta</span>
        </span>
      </div>
    </footer>
  );
}
