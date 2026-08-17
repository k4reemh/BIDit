import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  getInbox,
  getThreadApi,
  sendMessageApi,
  respondOfferApi,
  money2,
  fromMicros,
  type InboxRow,
  type Thread,
  type OfferCardData,
  type OfferAction,
  type Session,
} from '../api';
import { mediaSrc } from '../config';
import { renderChatText } from '../emotes';
import Avatar from '../components/Avatar';
import { Verified } from '../icons';

const THREAD_POLL_MS = 4000;
const INBOX_POLL_MS = 15000;

const ago = (ms: number) => {
  const s = Math.max(1, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return 'now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.round(h / 24)}d`;
};

const OFFER_STATUS_LABEL: Record<string, string> = {
  PENDING: 'Awaiting reply',
  COUNTERED: 'Countered',
  ACCEPTED: 'Accepted',
  DECLINED: 'Declined',
  CANCELED: 'Withdrawn',
  EXPIRED: 'Expired',
};

/** An offer card inside the thread: shows the numbers and, when the viewer can
 *  act on it, the accept / counter / decline / cancel controls. */
function OfferCard({ offer, myId, onAction, busy }: {
  offer: OfferCardData;
  myId: string;
  onAction: (offerId: string, action: OfferAction, counterAmount?: string) => void;
  busy: boolean;
}) {
  const [countering, setCountering] = useState(false);
  const [counter, setCounter] = useState('');
  const isSeller = myId === offer.sellerId;
  const isBuyer = myId === offer.buyerId;
  const amount = fromMicros(offer.amount)!;
  const counterAmt = offer.counterAmount ? fromMicros(offer.counterAmount) : null;
  const shipping = fromMicros(offer.shippingC) ?? 0;
  const live = offer.status === 'PENDING' || offer.status === 'COUNTERED';

  return (
    <div className={`offer-card${live ? '' : ' is-closed'}`}>
      <div className="offer-card__item">
        {offer.listingPhoto && <img src={mediaSrc(offer.listingPhoto) ?? undefined} alt="" />}
        <div>
          <Link to={`/marketplace/${offer.listingId}`} className="offer-card__title">{offer.listingTitle}</Link>
          {offer.askingPrice && <span className="muted">Asking ${money2(fromMicros(offer.askingPrice)!)}</span>}
        </div>
        <span className={`offer-card__status is-${offer.status.toLowerCase()}`}>{OFFER_STATUS_LABEL[offer.status] ?? offer.status}</span>
      </div>
      <div className="offer-card__nums">
        <div>
          <span className="muted">Offer</span>
          <b>${money2(amount)}</b>
        </div>
        {counterAmt !== null && (
          <div>
            <span className="muted">Counter</span>
            <b>${money2(counterAmt)}</b>
          </div>
        )}
        {shipping > 0 && (
          <div>
            <span className="muted">Shipping</span>
            <b>${money2(shipping)}</b>
          </div>
        )}
      </div>

      {live && offer.status === 'PENDING' && isSeller && (
        <div className="offer-card__actions">
          {!countering ? (
            <>
              <button className="btn btn-primary" disabled={busy} onClick={() => onAction(offer.offerId, 'accept')}>
                Accept ${money2(amount)}
              </button>
              <button className="btn btn-ghost" disabled={busy} onClick={() => setCountering(true)}>Counter</button>
              <button className="btn btn-ghost" disabled={busy} onClick={() => onAction(offer.offerId, 'decline')}>Decline</button>
            </>
          ) : (
            <>
              <div className="mkt-item__amt">
                <span>$</span>
                <input inputMode="decimal" autoFocus value={counter} onChange={(e) => setCounter(e.target.value)} placeholder="Counter amount" />
              </div>
              <button className="btn btn-primary" disabled={busy || !counter.trim()} onClick={() => onAction(offer.offerId, 'counter', counter)}>
                Send counter
              </button>
              <button className="btn btn-ghost" disabled={busy} onClick={() => setCountering(false)}>Back</button>
            </>
          )}
        </div>
      )}
      {live && offer.status === 'PENDING' && isBuyer && (
        <div className="offer-card__actions">
          <span className="muted">Funds reserved until the seller replies.</span>
          <button className="btn btn-ghost" disabled={busy} onClick={() => onAction(offer.offerId, 'cancel')}>Withdraw offer</button>
        </div>
      )}
      {live && offer.status === 'COUNTERED' && isBuyer && counterAmt !== null && (
        <div className="offer-card__actions">
          <button className="btn btn-primary" disabled={busy} onClick={() => onAction(offer.offerId, 'accept')}>
            Accept counter: pay ${money2(counterAmt + shipping)}
          </button>
          <button className="btn btn-ghost" disabled={busy} onClick={() => onAction(offer.offerId, 'decline')}>Decline</button>
        </div>
      )}
      {live && offer.status === 'COUNTERED' && isSeller && (
        <div className="offer-card__actions">
          <span className="muted">Waiting on the buyer.</span>
          <button className="btn btn-ghost" disabled={busy} onClick={() => onAction(offer.offerId, 'decline')}>Retract counter</button>
        </div>
      )}
    </div>
  );
}

export default function Messages({ session, onAuth }: { session: Session | null; onAuth: () => void }) {
  const { id } = useParams();
  const [inbox, setInbox] = useState<InboxRow[] | null>(null);
  const [thread, setThread] = useState<Thread | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const nav = useNavigate();
  const scroller = useRef<HTMLDivElement>(null);
  const stickBottom = useRef(true);

  const loadInbox = () => getInbox().then(setInbox).catch(() => setInbox((p) => p ?? []));
  const loadThread = () => {
    if (!id) return;
    getThreadApi(id)
      .then((t) => setThread(t))
      .catch(() => setThread(null));
  };

  useEffect(() => {
    if (!session) return;
    void loadInbox();
    const t = setInterval(loadInbox, INBOX_POLL_MS);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.userId]);

  useEffect(() => {
    if (!session || !id) { setThread(null); return; }
    setThread(null);
    void loadThread();
    const t = setInterval(loadThread, THREAD_POLL_MS);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, session?.userId]);

  // Keep the view pinned to the newest message unless the user scrolled up.
  useEffect(() => {
    const el = scroller.current;
    if (el && stickBottom.current) el.scrollTop = el.scrollHeight;
  }, [thread?.messages.length]);

  const offersById = useMemo(() => {
    const m = new Map<string, OfferCardData>();
    for (const o of thread?.offers ?? []) m.set(o.offerId, o);
    return m;
  }, [thread?.offers]);

  if (!session) {
    return (
      <main className="container msgs">
        <div className="mkt__empty"><b>Sign in to see your messages</b>
          <p className="muted">Offers and conversations with sellers live here.</p>
          <button className="btn btn-primary" onClick={onAuth}>Sign in</button></div>
      </main>
    );
  }

  const submit = async () => {
    if (!id || !text.trim()) return;
    setErr('');
    setBusy(true);
    try {
      await sendMessageApi(id, text);
      setText('');
      stickBottom.current = true;
      await loadThread();
      void loadInbox();
    } catch (e) {
      setErr((e as Error).message || 'Could not send that.');
    } finally {
      setBusy(false);
    }
  };

  const act = async (offerId: string, action: OfferAction, counterAmount?: string) => {
    setErr('');
    setBusy(true);
    try {
      await respondOfferApi(offerId, action, counterAmount);
      await loadThread();
    } catch (e) {
      setErr((e as Error).message || 'That didn’t go through.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="container msgs">
      <div className={`msgs__grid${id ? ' has-thread' : ''}`}>
        {/* Inbox */}
        <aside className="msgs__list">
          <h1 className="display msgs__h1">Messages</h1>
          {inbox === null ? (
            <p className="muted">Loading…</p>
          ) : inbox.length === 0 ? (
            <p className="muted">No conversations yet. Message a seller from any <Link to="/marketplace">marketplace</Link> listing.</p>
          ) : (
            inbox.map((c) => (
              <button
                key={c.conversationId}
                className={`msgs__row${c.conversationId === id ? ' is-on' : ''}`}
                onClick={() => nav(`/messages/${c.conversationId}`)}
              >
                <Avatar handle={c.other.handle} src={c.other.avatarUrl} size={38} />
                <span className="msgs__rowmain">
                  <span className="msgs__rowtop">
                    <b>@{c.other.handle}</b>
                    <span className="muted">{ago(c.lastMessageAt)}</span>
                  </span>
                  <span className={`msgs__preview${c.unread > 0 ? ' is-unread' : ''}`}>
                    {c.previewKind === 'OFFER' ? 'Offer' : (c.preview ?? '')}
                  </span>
                </span>
                {c.unread > 0 && <span className="msgs__dot">{c.unread}</span>}
              </button>
            ))
          )}
        </aside>

        {/* Thread */}
        <section className="msgs__thread">
          {!id ? (
            <div className="msgs__empty muted">Pick a conversation.</div>
          ) : thread === null ? (
            <div className="msgs__empty muted">Loading…</div>
          ) : (
            <>
              <header className="msgs__head">
                <Avatar handle={thread.other.handle} src={thread.other.avatarUrl} size={30} />
                <b>@{thread.other.handle}</b>
                {thread.other.verified && <span className="vpill"><Verified width={11} height={11} /> Verified</span>}
              </header>
              <div
                className="msgs__scroll"
                ref={scroller}
                onScroll={(e) => {
                  const el = e.currentTarget;
                  stickBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
                }}
              >
                {thread.messages.map((m) => {
                  if (m.kind === 'OFFER' && m.offerId) {
                    const card = offersById.get(m.offerId);
                    if (card) return <OfferCard key={m.id} offer={card} myId={session.userId} onAction={act} busy={busy} />;
                  }
                  if (m.kind === 'SYSTEM') {
                    return <div key={m.id} className="msgs__system muted">{m.text}</div>;
                  }
                  const mine = m.senderId === session.userId;
                  return (
                    <div key={m.id} className={`msgs__bubble${mine ? ' is-mine' : ''}`}>
                      {renderChatText(m.text ?? '')}
                    </div>
                  );
                })}
              </div>
              {err && <div className="auth__error" style={{ margin: '0 16px 8px' }}>{err}</div>}
              <div className="msgs__composer">
                <input
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void submit(); } }}
                  placeholder={`Message @${thread.other.handle}`}
                  maxLength={2000}
                  disabled={busy}
                />
                <button className="btn btn-primary" onClick={submit} disabled={busy || !text.trim()}>Send</button>
              </div>
            </>
          )}
        </section>
      </div>
    </main>
  );
}
