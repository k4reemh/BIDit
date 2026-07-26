import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import LiveCoinCard from '../components/LiveCoinCard';
import { getLive, type LiveCoin } from '../api';
import { CATEGORIES } from '../data';
import { countryFlag } from '../flag';
import { Search, Verified, X, Radio } from '../icons';

type SortKey = 'featured' | 'watched' | 'bid';

const SORTS: { key: SortKey; label: string }[] = [
  { key: 'featured', label: 'Live first' },
  { key: 'watched', label: 'Most watched' },
  { key: 'bid', label: 'Highest bid' },
];

/** "US" → "United States", falling back to the code for anything exotic. */
const regionName = (() => {
  try {
    const names = new Intl.DisplayNames(['en'], { type: 'region' });
    return (code: string) => names.of(code) ?? code;
  } catch {
    return (code: string) => code;
  }
})();

const isOn = (c: LiveCoin) => c.streamLive || c.hasAuction || c.hasGiveaway;
/** Ranking for the default sort: running auction > giveaway > stream only. */
const liveScore = (c: LiveCoin) => Number(c.hasAuction) * 4 + Number(c.hasGiveaway) * 2 + Number(c.streamLive);

const matchesQuery = (c: LiveCoin, q: string) =>
  [c.sellerHandle, c.streamTitle, c.coinName, c.title, c.category, c.prize]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
    .includes(q);

/**
 * /browse — every linked stream, filterable. Category chips, ships-from and
 * sort menus, and a verified-first toggle, all mirrored into the URL so a
 * filtered view can be shared or opened straight from the nav dropdown.
 */
export default function Browse() {
  const [params, setParams] = useSearchParams();
  const [live, setLive] = useState<LiveCoin[] | null>(null);

  const cat = params.get('cat') ?? '';
  const q = (params.get('q') ?? '').trim().toLowerCase();
  const from = params.get('from') ?? '';
  const sortParam = params.get('sort') as SortKey | null;
  const sort: SortKey = sortParam && SORTS.some((s) => s.key === sortParam) ? sortParam : 'featured';
  const verifiedFirst = params.get('verified') === '1';

  useEffect(() => {
    let dead = false;
    const load = () =>
      getLive()
        .then((l) => { if (!dead) setLive(l); })
        .catch(() => { if (!dead) setLive((prev) => prev ?? []); });
    load();
    // Live/offline flips show up on their own; the server caches pump lookups.
    const id = setInterval(load, 30_000);
    return () => { dead = true; clearInterval(id); };
  }, []);

  const set = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  };

  // Ships-from options come from the streams themselves, so the menu never
  // offers a country with zero results.
  const origins = useMemo(() => {
    const seen = new Map<string, { flag: string; label: string }>();
    for (const c of live ?? []) {
      const f = countryFlag(c.country);
      if (f && !seen.has(f.code)) seen.set(f.code, { flag: f.flag, label: regionName(f.code) });
    }
    return [...seen.entries()].sort((a, b) => a[1].label.localeCompare(b[1].label));
  }, [live]);

  const shown = useMemo(() => {
    if (!live) return null;
    let rows = [...new Map(live.map((c) => [c.coin, c])).values()];
    if (cat) rows = rows.filter((c) => (c.category ?? '').toLowerCase() === cat.toLowerCase());
    if (from) rows = rows.filter((c) => countryFlag(c.country)?.code === from);
    if (q) rows = rows.filter((c) => matchesQuery(c, q));
    rows.sort((a, b) => {
      if (sort === 'watched') return b.viewers - a.viewers || liveScore(b) - liveScore(a);
      if (sort === 'bid') return Number(b.currentBid ?? 0) - Number(a.currentBid ?? 0) || b.viewers - a.viewers;
      return liveScore(b) - liveScore(a) || b.viewers - a.viewers;
    });
    if (verifiedFirst) rows = [...rows.filter((c) => c.verified), ...rows.filter((c) => !c.verified)];
    return rows;
  }, [live, cat, from, q, sort, verifiedFirst]);

  const liveCount = shown?.filter(isOn).length ?? 0;
  const filtered = Boolean(cat || from || q || verifiedFirst);

  return (
    <main className="container browse">
      <header className="browse__head">
        <div>
          <h1 className="display browse__title">Browse</h1>
          <p className="muted browse__sub">
            {shown === null
              ? 'Finding streams'
              : shown.length === 0
                ? 'No streams to show'
                : `${shown.length} ${shown.length === 1 ? 'stream' : 'streams'}${liveCount ? ` · ${liveCount} live now` : ''}`}
          </p>
        </div>
        {q && (
          <button className="browse__q" onClick={() => set('q', '')} title="Clear search">
            <Search width={14} height={14} /> {params.get('q')} <X width={13} height={13} />
          </button>
        )}
      </header>

      <div className="browse__cats" aria-label="Filter by category">
        <button className={`chip${cat ? '' : ' on'}`} aria-pressed={!cat} onClick={() => set('cat', '')}>
          All
        </button>
        {CATEGORIES.map((c) => {
          const on = cat.toLowerCase() === c.name.toLowerCase();
          return (
            <button key={c.name} className={`chip${on ? ' on' : ''}`} aria-pressed={on} onClick={() => set('cat', on ? '' : c.name)}>
              {c.name}
            </button>
          );
        })}
      </div>

      <div className="browse__bar">
        <label className="browse__ctl">
          <span>Ships from</span>
          <select value={from} onChange={(e) => set('from', e.target.value)}>
            <option value="">Anywhere</option>
            {origins.map(([code, o]) => (
              <option key={code} value={code}>{o.flag} {o.label}</option>
            ))}
          </select>
        </label>
        <label className="browse__ctl">
          <span>Sort by</span>
          <select value={sort} onChange={(e) => set('sort', e.target.value === 'featured' ? '' : e.target.value)}>
            {SORTS.map((s) => (
              <option key={s.key} value={s.key}>{s.label}</option>
            ))}
          </select>
        </label>
        <button
          className={`chip chip--seal${verifiedFirst ? ' on' : ''}`}
          aria-pressed={verifiedFirst}
          onClick={() => set('verified', verifiedFirst ? '' : '1')}
        >
          <Verified width={14} height={14} /> Verified first
        </button>
        {filtered && (
          <button className="browse__clear" onClick={() => setParams({}, { replace: true })}>
            Clear filters
          </button>
        )}
      </div>

      {shown === null ? (
        <div className="live-grid">
          {Array.from({ length: 8 }, (_, i) => (
            <div key={i} className="live-skel" aria-hidden />
          ))}
        </div>
      ) : shown.length > 0 ? (
        <div className="live-grid">
          {shown.map((c) => (
            <LiveCoinCard key={c.coin} c={c} />
          ))}
        </div>
      ) : (
        <div className="browse__empty">
          <span className="browse__empty-ic"><Radio width={26} height={26} /></span>
          {filtered ? (
            <>
              <h2>Nothing matches those filters</h2>
              <p className="muted">Try a different category or region, or clear everything and start over.</p>
              <button className="btn btn-ghost" onClick={() => setParams({}, { replace: true })}>Clear filters</button>
            </>
          ) : (
            <>
              <h2>No streams yet</h2>
              <p className="muted">Sellers are setting up shop. Check back soon, or claim your corner of the marketplace first.</p>
              <Link className="btn btn-primary" to="/sell">Become a seller</Link>
            </>
          )}
        </div>
      )}
    </main>
  );
}
