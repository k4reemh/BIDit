import { Link } from 'react-router-dom';

export default function Logo({ size = 28 }: { size?: number }) {
  return (
    <Link to="/" style={{ display: 'inline-flex', alignItems: 'center', gap: 9 }} aria-label="BIDit home">
      <span
        style={{
          width: size,
          height: size,
          borderRadius: size * 0.3,
          background: 'var(--ink)',
          display: 'grid',
          placeItems: 'center',
          flex: 'none',
        }}
      >
        <svg width={size * 0.54} height={size * 0.54} viewBox="0 0 24 24" fill="#fff">
          <path d="M13 2 4 14h6l-1 8 9-12h-6l1-8Z" />
        </svg>
      </span>
      <span style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: size * 0.64, letterSpacing: '-0.02em', color: 'var(--ink)' }}>
        BID<span style={{ color: 'var(--accent-strong)' }}>it</span>
      </span>
    </Link>
  );
}
