import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useSeller } from '../../components/SellerLayout';
import {
  openSocket,
  type AuctionState,
  type AuctionClosed,
  type GiveawayOpen,
  type GiveawayEntrant,
  type GiveawayWinner,
} from '../../realtime';
import { openGiveaway, drawGiveaway, getGiveaway, type GiveawayKind } from '../../api';
import Avatar from '../../components/Avatar';
import GiveawayReveal from '../../components/GiveawayReveal';
import ChatPanel from '../../components/ChatPanel';
import ImageUpload from '../../components/ImageUpload';
import { Tag, Gift, Users, Bag, Chat } from '../../icons';

interface FeedItem { who: string; amt: string; key: number }

export default function Live() {
  const { session } = useSeller();
  const [auction, setAuction] = useState<AuctionState | null>(null);
  const [closed, setClosed] = useState<AuctionClosed | null>(null);
  const [feed, setFeed] = useState<FeedItem[]>([]);
  const offset = useRef(0);
  const keyRef = useRef(0);
  const lastAuctionId = useRef<string | null>(null);
  const [, setTick] = useState(0);

  // giveaway state
  const [giveaway, setGiveaway] = useState<GiveawayOpen | null>(null);
  const [entrants, setEntrants] = useState<{ count: number; recent: GiveawayEntrant[] }>({ count: 0, recent: [] });
  const [winner, setWinner] = useState<GiveawayWinner | null>(null);
  const [gKind, setGKind] = useState<GiveawayKind>('PUBLIC');
  const [gPrize, setGPrize] = useState('');
  const [gImg, setGImg] = useState('');
  const [gDur, setGDur] = useState(45);
  const [gBusy, setGBusy] = useState(false);
  const [gErr, setGErr] = useState('');

  useEffect(() => {
    const stop = openSocket({
      room: session.userId,
      onState: (m) => {
        offset.current = m.serverNow - Date.now();
        if (m.auctionId !== lastAuctionId.current) {
          lastAuctionId.current = m.auctionId;
          setFeed([]); // new item → clear the previous item's bids
        }
        if (m.status === 'RUNNING') setClosed(null);
        setAuction(m);
      },
      onBid: (m) => {
        offset.current = m.serverNow - Date.now();
        setAuction((a) => (a ? { ...a, currentBid: m.amount, leaderHandle: m.leaderHandle, endsAt: m.endsAt } : a));
        setFeed((f) => [{ who: m.leaderHandle, amt: m.amount, key: keyRef.current++ }, ...f].slice(0, 8));
      },
      onClosed: (m) => setClosed(m),
      onGiveawayOpen: (m) => {
        offset.current = m.serverNow - Date.now();
        setWinner(null);
        setGiveaway(m);
        setEntrants({ count: m.entrantCount, recent: [] });
      },
      onGiveawayEntries: (m) => {
        offset.current = m.serverNow - Date.now();
        setEntrants({ count: m.count, recent: m.recent });
      },
      onGiveawayWinner: (m) => {
        setGiveaway(null);
        setWinner(m);
      },
    });
    return stop;
  }, [session.userId]);

  // restore an already-open giveaway when landing on the page mid-stream
  useEffect(() => {
    getGiveaway().then((g) => {
      if (g && g.status === 'OPEN') {
        setGiveaway({
          giveawayId: g.id,
          kind: g.kind,
          prize: g.prize,
          image: g.image,
          sellerHandle: session.handle,
          opensAt: g.opensAt,
          closesAt: g.closesAt,
          entrantCount: 0,
          seedHash: g.seedHash,
          serverNow: Date.now(),
        });
      }
    }).catch(() => {});
  }, [session.userId, session.handle]);

  useEffect(() => {
    const t = setInterval(() => setTick((x) => x + 1), 150);
    return () => clearInterval(t);
  }, []);

  const running = auction && auction.status === 'RUNNING';
  const remaining = running && auction!.endsAt ? Math.max(0, (auction!.endsAt - (Date.now() + offset.current)) / 1000) : null;
  const pct = remaining !== null && auction!.durationSeconds ? Math.max(0, Math.min(100, (remaining / auction!.durationSeconds) * 100)) : 0;
  const low = remaining !== null && remaining <= 10;

  // giveaway countdown
  const gRemaining = giveaway ? Math.max(0, (giveaway.closesAt - (Date.now() + offset.current)) / 1000) : 0;
  const gSpan = giveaway ? Math.max(1, (giveaway.closesAt - giveaway.opensAt) / 1000) : 1;
  const gPct = giveaway ? Math.max(0, Math.min(100, (gRemaining / gSpan) * 100)) : 0;

  const launch = async () => {
    if (!gPrize.trim() || gBusy) return;
    setGBusy(true);
    setGErr('');
    try {
      await openGiveaway({ kind: gKind, prize: gPrize.trim(), image: gImg || null, durationSeconds: gDur });
      setGPrize('');
      setGImg('');
    } catch (e) {
      setGErr(e instanceof Error ? e.message : 'Could not start giveaway');
    } finally {
      setGBusy(false);
    }
  };

  const draw = async () => {
    if (!giveaway) return;
    setGErr('');
    try {
      await drawGiveaway(giveaway.giveawayId);
    } catch (e) {
      setGErr(e instanceof Error ? e.message : 'Could not draw');
    }
  };

  return (
    <>
      <div className="acct-head">
        <h1 className="display acct-title">Live monitor</h1>
        <p className="muted">Watch your running auction in real time — exactly what viewers see in the overlay.</p>
      </div>

      {closed && (
        <div className="lm-closed card">
          <span className="live-badge" style={{ background: 'var(--accent)' }}>SOLD</span>
          <div>{closed.winnerHandle ? <>Won by <b>@{closed.winnerHandle}</b> for <b>${closed.amount}</b></> : 'Closed with no sale'}</div>
        </div>
      )}

      {!running ? (
        <div className="empty card">
          <span className="empty__ic"><Tag width={26} height={26} /></span>
          <h3>No live auction running</h3>
          <p className="muted">Start an auction from your listings and it’ll appear here — with the bids streaming in live.</p>
          <Link className="btn btn-primary" to="/seller/listings">Go to listings</Link>
        </div>
      ) : (
        <div className="lm">
          <div className="lm__main card">
            <div className="lm__top">
              <div className="lm__thumb">{auction!.imageUrl ? <img src={auction!.imageUrl} alt="" /> : <Tag width={22} height={22} />}</div>
              <div className="lm__id">
                <span className="live-badge"><span className="dot" /> LIVE</span>
                <div className="lm__title">{auction!.title}</div>
              </div>
            </div>
            <div className="lm__stats">
              <div className="lm__stat"><span>Current bid</span><b>{auction!.currentBid ? `$${auction!.currentBid}` : '—'}</b></div>
              <div className="lm__stat lm__stat--r"><span>Ends in</span><b className={low ? 'lm__timer low' : 'lm__timer'}>{remaining!.toFixed(1)}s</b></div>
            </div>
            <div className="lm__bar"><div className={low ? 'lm__fill low' : 'lm__fill'} style={{ width: `${pct}%` }} /></div>
            <div className="lm__leader">
              {auction!.leaderHandle
                ? <><Avatar handle={auction!.leaderHandle} size={20} /> <b>@{auction!.leaderHandle}</b> leading · min next ${auction!.minNextBid}</>
                : <>No bids yet · starts at ${auction!.minNextBid}</>}
            </div>
          </div>
          <div className="lm__feed card">
            <h3 className="acct-sub">Live bids</h3>
            {feed.length === 0 ? (
              <p className="muted" style={{ fontSize: 13.5 }}>Waiting for the first bid…</p>
            ) : (
              <div className="lm__feedlist">
                {feed.map((f) => (
                  <div className="lm__feedrow" key={f.key}><Avatar handle={f.who} size={22} /><b>@{f.who}</b><span className="lm__feedamt">${f.amt}</span></div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* ---- Giveaways ---- */}
      <h2 className="sl-sec"><Gift width={20} height={20} style={{ verticalAlign: '-3px', marginRight: 6 }} /> Giveaway</h2>

      {!giveaway ? (
        <div className="card gv-launch">
          <p className="muted gv-launch__lead">Reward the room with a free prize. Pick who can enter, name the prize, and go — the winner is drawn live and provably fair.</p>
          <div className="gv-kinds">
            <button className={`gv-kind${gKind === 'PUBLIC' ? ' active' : ''}`} onClick={() => setGKind('PUBLIC')}>
              <span className="gv-kind__ic"><Users width={18} height={18} /></span>
              <b>Everyone</b>
              <span className="muted">Any viewer watching the stream can enter.</span>
            </button>
            <button className={`gv-kind${gKind === 'BUYER_ONLY' ? ' active' : ''}`} onClick={() => setGKind('BUYER_ONLY')}>
              <span className="gv-kind__ic"><Bag width={18} height={18} /></span>
              <b>Buyers only</b>
              <span className="muted">Only people who’ve purchased from you can enter.</span>
            </button>
          </div>
          <div className="gv-photo">
            <ImageUpload value={gImg} onChange={setGImg} compact />
            <span className="muted">Prize photo <em>— optional</em></span>
          </div>
          <div className="gv-form">
            <input
              className="gv-input"
              placeholder="Prize — e.g. Charizard ex Alt Art slab"
              value={gPrize}
              onChange={(e) => setGPrize(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && launch()}
            />
            <select className="gv-dur" value={gDur} onChange={(e) => setGDur(Number(e.target.value))}>
              <option value={30}>30s</option>
              <option value={45}>45s</option>
              <option value={60}>1 min</option>
              <option value={120}>2 min</option>
            </select>
            <button className="btn btn-primary" onClick={launch} disabled={gBusy || !gPrize.trim()}>
              {gBusy ? 'Starting…' : 'Start giveaway'}
            </button>
          </div>
          {gErr && <p className="gv-err">{gErr}</p>}
        </div>
      ) : (
        <div className="card gv-live">
          <div className="gv-live__head">
            <span className={`gv-badge gv-badge--${giveaway.kind === 'BUYER_ONLY' ? 'buyer' : 'public'}`}>
              {giveaway.kind === 'BUYER_ONLY' ? 'Buyers only' : 'Everyone'}
            </span>
            {giveaway.image && <img className="gv-live__img" src={giveaway.image} alt="" />}
            <div className="gv-live__prize">{giveaway.prize}</div>
          </div>
          <div className="gv-live__body">
            <div className="gv-live__count">
              <b>{entrants.count}</b>
              <span className="muted">{entrants.count === 1 ? 'entry' : 'entries'}</span>
            </div>
            <div className="gv-live__mid">
              <div className="gv-live__timer">closes in <b>{gRemaining >= 10 ? Math.ceil(gRemaining) : gRemaining.toFixed(1)}s</b></div>
              <div className="gv-bar"><div className="gv-bar__fill" style={{ width: `${gPct}%` }} /></div>
              <div className="gv-avs">
                {entrants.recent.slice(0, 9).map((e) => (
                  <span className="gv-av" key={e.userId}><Avatar handle={e.handle} size={26} /></span>
                ))}
                {entrants.count > 9 && <span className="gv-more">+{entrants.count - 9}</span>}
                {entrants.count === 0 && <span className="muted" style={{ fontSize: 13 }}>Waiting for entries…</span>}
              </div>
            </div>
          </div>
          <div className="gv-live__foot">
            <button className="btn btn-accent" onClick={draw} disabled={entrants.count === 0}>Draw winner now</button>
            <span className="muted gv-live__note">Draws automatically when the timer ends.</span>
          </div>
          {gErr && <p className="gv-err">{gErr}</p>}
        </div>
      )}

      {/* ---- Live chat ---- */}
      <h2 className="sl-sec"><Chat width={20} height={20} style={{ verticalAlign: '-3px', marginRight: 6 }} /> Live chat</h2>
      <p className="muted" style={{ marginTop: -6, marginBottom: 4, fontSize: 13.5 }}>Messages from viewers watching your stream — delete or block with the controls on each message.</p>
      <ChatPanel room={session.userId} session={session} onAuth={() => {}} />

      {winner && (
        <GiveawayReveal win={winner} isMe={winner.winnerUserId === session.userId} onDone={() => setWinner(null)} />
      )}
    </>
  );
}
