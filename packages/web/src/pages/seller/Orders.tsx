import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useSeller } from '../../components/SellerLayout';
import { getSellerSales, type SaleRow } from '../../api';
import EmptyState from '../../components/EmptyState';
import { Truck, Tag, Gift } from '../../icons';

const PAGE = 50;
type Kind = 'all' | 'auction' | 'store' | 'giveaway';
const KINDS: Array<[Kind, string]> = [['all', 'All'], ['auction', 'Auctions'], ['store', 'Buy now'], ['giveaway', 'Giveaways']];

const day = (ms: number) =>
  new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) +
  ' · ' +
  new Date(ms).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

/** Read-only: the seller never marks an order shipped/delivered or enters a tracking
 *  number. They confirm the package size in Shipments; BIDit creates the label + the
 *  tracking number, and the carrier's scans drive shipped → delivered automatically. */
function SaleCard({ o }: { o: SaleRow }) {
  const isGw = o.kind === 'giveaway';
  return (
    <div className="ord card">
      <div className="ord__thumb">{o.image ? <img src={o.image} alt="" /> : isGw ? <Gift width={20} height={20} /> : <Tag width={20} height={20} />}</div>
      <div className="ord__main">
        <div className="ord__title">{o.title}</div>
        <div className="ord__sub muted">
          Won by <b>@{o.buyer}</b> · {isGw ? 'Free giveaway' : `$${o.amount}`} · {day(o.createdAt)}
        </div>
      </div>
      <div className="ord__side">
        <span className={`pill ord__status ord__status--${o.status.toLowerCase()}`}>{o.status.replace(/_/g, ' ')}</span>
        {!isGw && <span className="ord__proceeds muted">You get ${o.sellerProceeds}</span>}
      </div>
    </div>
  );
}

export default function Orders() {
  useSeller();
  const [rows, setRows] = useState<SaleRow[] | null>(null);
  const [total, setTotal] = useState(0);
  const [busy, setBusy] = useState(false);
  const [q, setQ] = useState('');
  const [kind, setKind] = useState<Kind>('all');
  const [fromDay, setFromDay] = useState('');
  const [toDay, setToDay] = useState('');
  // Bumps on every filter change; stale in-flight responses check it and drop.
  const reqSeq = useRef(0);

  const filters = () => ({
    q: q.trim() || undefined,
    kind,
    // Day inputs are local dates; cover the WHOLE from-day and to-day.
    fromMs: fromDay ? new Date(`${fromDay}T00:00:00`).getTime() : undefined,
    toMs: toDay ? new Date(`${toDay}T23:59:59.999`).getTime() : undefined,
  });

  const load = async (append: boolean) => {
    const seq = ++reqSeq.current;
    setBusy(true);
    try {
      const page = await getSellerSales({ ...filters(), skip: append ? rows?.length ?? 0 : 0, take: PAGE });
      if (seq !== reqSeq.current) return; // a newer filter change superseded this
      setTotal(page.total);
      setRows((prev) => (append && prev ? [...prev, ...page.rows] : page.rows));
    } catch {
      if (seq === reqSeq.current && !append) setRows([]);
    } finally {
      if (seq === reqSeq.current) setBusy(false);
    }
  };

  // Reload from the top whenever a filter changes (text search included: it's
  // cheap at this scale and saves a "Search" button press mid-fulfillment).
  useEffect(() => {
    void load(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, kind, fromDay, toDay]);

  const shown = rows?.length ?? 0;

  return (
    <>
      <div className="acct-head">
        <h1 className="display acct-title">Orders</h1>
        <p className="muted">
          Every sale on your account: auction wins, buy-now orders and giveaway prizes. To send one, confirm its
          box size in <Link to="/seller/shipments">Shipments</Link>. We create the label, and tracking updates on its own.
        </p>
      </div>

      <div className="salesbar">
        <input
          className="salesbar__q"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Filter by buyer @username"
          aria-label="Filter by buyer username"
        />
        <div className="salesbar__kinds">
          {KINDS.map(([k, label]) => (
            <button key={k} className={`chip${kind === k ? ' on' : ''}`} aria-pressed={kind === k} onClick={() => setKind(k)}>
              {label}
            </button>
          ))}
        </div>
        <div className="salesbar__dates">
          <input type="date" value={fromDay} onChange={(e) => setFromDay(e.target.value)} aria-label="From day" />
          <span className="muted">to</span>
          <input type="date" value={toDay} onChange={(e) => setToDay(e.target.value)} aria-label="To day" />
          {(fromDay || toDay || q || kind !== 'all') && (
            <button className="salesbar__clear" onClick={() => { setQ(''); setKind('all'); setFromDay(''); setToDay(''); }}>
              Clear
            </button>
          )}
        </div>
      </div>

      {rows === null ? (
        <div className="muted" style={{ padding: 20 }}>Loading…</div>
      ) : rows.length === 0 ? (
        <EmptyState
          icon={Truck}
          title={total === 0 && !q && kind === 'all' && !fromDay && !toDay ? 'No orders yet' : 'Nothing matches those filters'}
          sub={total === 0 && !q ? 'When a buyer wins one of your auctions it shows up here.' : 'Try clearing the filters.'}
        />
      ) : (
        <>
          <div className="ord-list">{rows.map((o) => <SaleCard key={o.id} o={o} />)}</div>
          <div className="salesbar__foot">
            <span className="muted">Showing {shown} of {total}</span>
            {shown < total && (
              <button className="btn btn-ghost" onClick={() => void load(true)} disabled={busy}>
                {busy ? 'Loading…' : `Load ${Math.min(PAGE, total - shown)} more`}
              </button>
            )}
          </div>
        </>
      )}
    </>
  );
}
