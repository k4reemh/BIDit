import { Link } from 'react-router-dom';
import Logo from './Logo';
import { XLogo } from '../icons';

type FLink = string | { label: string; to: string };
const COLS: { h: string; links: FLink[] }[] = [
  { h: 'Marketplace', links: ['Live now', 'Browse', 'Categories', { label: 'Sell on BIDit', to: '/seller' }] },
  { h: 'Resources', links: [{ label: 'Docs', to: '/docs' }, { label: '$BID token', to: '/docs#tokenomics' }, 'Status', 'Developer API'] },
  { h: 'Company', links: ['About', 'Careers', 'Blog', 'Press'] },
  { h: 'Legal', links: ['Terms', 'Privacy', { label: 'Shipping policy', to: '/docs#escrow' }, 'Contact'] },
];

export default function Footer() {
  return (
    <footer className="footer">
      <div className="container footer__top">
        <div className="footer__brand">
          <Logo size={30} />
          <p className="muted">The live card auction that lives on the streams you already watch. Win it, we ship it, 5% pumps $BID.</p>
          <div className="footer__social">
            <a className="icon-btn" href="https://x.com/biditsol" target="_blank" rel="noreferrer" aria-label="BIDit on X"><XLogo width={18} height={18} /></a>
            <a className="icon-btn" href="#" aria-label="Discord" style={{ fontSize: 18 }}>◇</a>
          </div>
        </div>
        <div className="footer__cols">
          {COLS.map((c) => (
            <div key={c.h} className="footer__col">
              <h4>{c.h}</h4>
              {c.links.map((l) =>
                typeof l === 'string'
                  ? <a key={l} href="#">{l}</a>
                  : <Link key={l.label} to={l.to}>{l.label}</Link>,
              )}
            </div>
          ))}
        </div>
      </div>
      <div className="container footer__bar">
        <span className="muted">© 2026 BIDit. All rights reserved.</span>
        <span className="footer__chips">
          <span className="pill">◎ Built on Solana</span>
          <span className="pill" style={{ color: 'var(--green)' }}>● Devnet beta</span>
        </span>
      </div>
    </footer>
  );
}
