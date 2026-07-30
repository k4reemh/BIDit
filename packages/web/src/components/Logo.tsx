import { Link } from 'react-router-dom';

/** Wordmark-only logo. `size` keeps its old meaning (the old mark height) so
 *  existing call sites scale the same; the text is sized off it. */
export default function Logo({ size = 28 }: { size?: number }) {
  return (
    <Link to="/" style={{ display: 'inline-flex', alignItems: 'center' }} aria-label="BIDit home">
      <span style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: size * 0.72, letterSpacing: '-0.02em', color: 'var(--ink)' }}>
        BID<span style={{ color: 'var(--accent-strong)' }}>it</span>
      </span>
    </Link>
  );
}
