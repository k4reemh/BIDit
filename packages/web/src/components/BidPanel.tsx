import { useEffect, useRef, useState } from 'react';
import Avatar from './Avatar';
import GiveawayReveal from './GiveawayReveal';
import WinCelebration, { type WinInfo } from './WinCelebration';
import WheelReveal from './WheelReveal';
import {
  openRoom,
  type RoomController,
  type AuctionState,
  type GiveawayOpen,
  type GiveawayEntrant,
  type GiveawayWinner,
  type RandomizerSpin,
} from '../realtime';
import type { Session } from '../api';
import { Gift, Bolt, Dice, Chevron } from '../icons';

interface Feed { who: string; amt: string; key: number }

/**
 * The in-site bidding sidebar — a clean, always-on version of the extension
 * overlay. Connects to a seller's room, renders the live auction + giveaway +
 * wheel, and (for a signed-in viewer) bids / enters directly on the site, so no
 * extension is needed. Requires sign-in because the socket is token-gated.
 *
 * Wallet balance shows the viewer's total money and does NOT drop while bidding —
 * a live bid only reserves funds; the balance is only spent when they WIN.
 */
export default function BidPanel({
  room,
  session,
  onAuth,
}: {
  room: string;
  session: Session | null;
  onAuth: () => void;
}) {
  const [auction, setAuction] = useState<AuctionState | null>(null);
  const [soldMsg, setSoldMsg] = useState<string | null>(null);
  const [feed, setFeed] = useState<Feed[]>([]);
  const [balance, setBalance] = useState(session?.settled ?? '0'); // total wallet balance
  const [amount, setAmount] = useState('');
  const [reject, setReject] = useState('');

  const [giveaway, setGiveaway] = useState<GiveawayOpen | null>(null);
  const [gCount, setGCount] = useState(0);
  const [gRecent, setGRecent] = useState<GiveawayEntrant[]>([]);
  const [gEntered, setGEntered] = useState(false);
  const [gWinner, setGWinner] = useState<GiveawayWinner | null>(null);

  const [spin, setSpin] = useState<RandomizerSpin | null>(null);
  const [win, setWin] = useState<WinInfo | null>(null);
  const [showPrizes, setShowPrizes] = useState(false);

  const ctl = useRef<RoomController | null>(null);
  const offset = useRef(0);
  const keyRef = useRef(0);
  const lastAuctionId = useRef<string | null>(null);
  const item = useRef<{ title: string; image: string | null }>({ title: 'this item', image: null });
  const myHandle = session?.handle ?? null;
  const [, setTick] = useState(0);

  useEffect(() => {
    if (!session) return; // socket is token-gated; signed-out shows the CTA below
    const c = openRoom(room, {
      onBalance: (b) => setBalance(b.settled),
      onState: (m) => {
        offset.current = m.serverNow - Date.now();
        // New item → drop the previous item's bid feed so it doesn't linger.
        if (m.auctionId !== lastAuctionId.current) {
          lastAuctionId.current = m.auctionId;
          setFeed([]);
          setReject('');
          setShowPrizes(false);
        }
        if (m.status === 'RUNNING') setSoldMsg(null);
        item.current = { title: m.title, image: m.imageUrl };
        setAuction(m);
      },
      onBid: (m) => {
        offset.current = m.serverNow - Date.now();
        setAuction((a) => (a ? { ...a, currentBid: m.amount, leaderHandle: m.leaderHandle, endsAt: m.endsAt } : a));
        setFeed((f) => [{ who: m.leaderHandle, amt: m.amount, key: keyRef.current++ }, ...f].slice(0, 6));
      },
      onClosed: (m) => {
        setSoldMsg(m.winnerHandle ? `Sold to @${m.winnerHandle} for $${m.amount}` : 'Auction ended — no sale');
        setAuction((a) => (a ? { ...a, status: 'SETTLING' } : a));
        // A wheel auction defers its celebration to the spin; otherwise celebrate now.
        if (!m.wheel && m.winnerHandle && m.amount) {
          setWin({ winnerHandle: m.winnerHandle, amount: m.amount, title: item.current.title, imageUrl: item.current.image, isMe: m.winnerHandle === myHandle });
        }
      },
      onBidRejected: (m) => setReject(rejectText(m.reason)),
      onSpin: (m) => setSpin(m),
      onGiveawayOpen: (m) => {
        offset.current = m.serverNow - Date.now();
        setGWinner(null);
        setGEntered(false);
        setGiveaway(m);
        setGCount(m.entrantCount);
        setGRecent([]);
      },
      onGiveawayEntries: (m) => {
        offset.current = m.serverNow - Date.now();
        setGCount(m.count);
        setGRecent(m.recent);
      },
      onGiveawayRejected: (m) => setReject(m.reason === 'NOT_ELIGIBLE' ? 'Buyers only — purchase to enter' : 'Entry closed'),
      onGiveawayWinner: (m) => {
        setGiveaway(null);
        setGWinner(m);
      },
    });
    ctl.current = c;
    return () => c.close();
  }, [room, session?.userId]);

  // Only tick while a live countdown is on screen (running auction or open
  // giveaway). This stops the panel from re-rendering during the wheel/win/
  // giveaway reveal animations, keeping them smooth.
  const needTick = auction?.status === 'RUNNING' || giveaway != null;
  useEffect(() => {
    if (!needTick) return;
    const t = setInterval(() => setTick((x) => x + 1), 100);
    return () => clearInterval(t);
  }, [needTick]);

  const running = auction && auction.status === 'RUNNING';
  const minNext = auction?.minNextBid ?? '0';
  useEffect(() => {
    setAmount((a) => (!a || Number(a) < Number(minNext) ? minNext : a));
  }, [minNext]);

  const remaining = running && auction!.endsAt ? Math.max(0, (auction!.endsAt - (Date.now() + offset.current)) / 1000) : null;
  const pct = remaining !== null && auction!.durationSeconds ? Math.max(0, Math.min(100, (remaining / auction!.durationSeconds) * 100)) : 0;
  const low = remaining !== null && remaining <= 10;

  const placeBid = () => {
    setReject('');
    if (!session) return onAuth();
    if (!auction || !running) return;
    ctl.current?.bid(auction.auctionId, amount || minNext);
  };

  const enter = () => {
    setReject('');
    if (!session) return onAuth();
    if (!giveaway) return;
    ctl.current?.enterGiveaway(giveaway.giveawayId);
    setGEntered(true);
  };

  const gRemaining = giveaway ? Math.max(0, (giveaway.closesAt - (Date.now() + offset.current)) / 1000) : 0;
  const gPct = giveaway ? Math.max(0, Math.min(100, (gRemaining / Math.max(1, (giveaway.closesAt - giveaway.opensAt) / 1000)) * 100)) : 0;
  const gLow = gRemaining <= 5;

  return (
    <aside className="bp">
      <div className="bp__head">
        <span className="bp__brand"><Bolt width={15} height={15} /> Live bidding</span>
        {session && <span className="bp__bal" title="Your wallet balance">${balance}</span>}
      </div>

      {!session ? (
        <div className="bp__gate">
          <p>Sign in to watch the live auction and place bids — right here, no extension.</p>
          <button className="btn btn-primary bp__gatebtn" onClick={onAuth}>Sign in to bid</button>
        </div>
      ) : (
        <>
          {soldMsg && !running && <div className="bp__sold">{soldMsg}</div>}

          {running ? (
            <>
              <div className="bp__item">
                <div className="bp__thumb">{auction!.imageUrl ? <img src={auction!.imageUrl} alt="" /> : <Bolt width={20} height={20} />}</div>
                <div className="bp__itemid">
                  <span className="live-badge"><span className="dot" /> LIVE</span>
                  <div className="bp__title">{auction!.title}</div>
                </div>
              </div>
              {auction!.wheel && auction!.wheel.length > 0 && (
                <div className="bp__prizes-wrap">
                  <button type="button" className="bp__prizes-toggle" onClick={() => setShowPrizes((v) => !v)}>
                    <Dice width={14} height={14} /> {auction!.wheel!.length} prizes on the wheel
                    <Chevron width={14} height={14} className={`bp__prizes-chev${showPrizes ? ' up' : ''}`} />
                  </button>
                  {showPrizes && (
                    <div className="bp__prizes">
                      {auction!.wheel!.map((p, i) => (
                        <div className="bp__prize" key={i}>
                          {p.imageUrl ? <img className="bp__prize-img" src={p.imageUrl} alt="" /> : <span className="bp__prize-dot" />}
                          <span className="bp__prize-label">{p.label}</span>
                          <span className="bp__prize-qty">×{p.weight ?? 1}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
              <div className="bp__bidrow">
                <div className="bp__cur"><span>Current bid</span><b>{auction!.currentBid ? `$${auction!.currentBid}` : '—'}</b></div>
                <div className={`bp__timer${low ? ' low' : ''}`}>{remaining!.toFixed(1)}s</div>
              </div>
              <div className="bp__bar"><div className={`bp__fill${low ? ' low' : ''}`} style={{ width: `${pct}%` }} /></div>
              <div className="bp__leader">
                {auction!.leaderHandle
                  ? <><Avatar handle={auction!.leaderHandle} size={18} /> <b>@{auction!.leaderHandle}</b> leading</>
                  : <>No bids yet</>}
              </div>
              <div className="bp__quick">
                {[0, 5, 10].map((inc) => {
                  const v = Math.round((Number(minNext) + inc) * 100) / 100;
                  return (
                    <button key={inc} type="button" className={`bp__quickbtn${Number(amount) === v ? ' on' : ''}`} onClick={() => setAmount(String(v))}>
                      {inc === 0 ? `Min $${minNext}` : `+$${inc}`}
                    </button>
                  );
                })}
              </div>
              <div className="bp__act">
                <div className="bp__amt">
                  <span>$</span>
                  <input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ''))} />
                </div>
                <button className="btn btn-primary bp__bid" onClick={placeBid}>Bid ${amount || minNext}</button>
              </div>
              <div className="bp__min">Minimum next bid ${minNext} · won’t leave your wallet until you win</div>
              {reject && <div className="bp__reject">{reject}</div>}
              {feed.length > 0 && (
                <div className="bp__feed">
                  {feed.map((f) => (
                    <div className="bp__feedrow" key={f.key}><Avatar handle={f.who} size={18} /><b>@{f.who}</b><span>${f.amt}</span></div>
                  ))}
                </div>
              )}
            </>
          ) : (
            !giveaway && (
              <div className="bp__empty">
                <span className="bp__emptyic"><Bolt width={22} height={22} /></span>
                <b>Waiting for the next item…</b>
                <p>When the seller starts an auction it appears here instantly.</p>
              </div>
            )
          )}

          {giveaway && (
            <div className="bp__gv">
              <div className="bp__gvhead">
                <span className={`gv-badge gv-badge--${giveaway.kind === 'BUYER_ONLY' ? 'buyer' : 'public'}`}>
                  <Gift width={12} height={12} style={{ verticalAlign: '-2px' }} /> {giveaway.kind === 'BUYER_ONLY' ? 'Buyers only' : 'Giveaway'}
                </span>
                <span className="bp__gvcount">{gCount} in</span>
              </div>
              <div className="bp__gvitem">
                {giveaway.image && <img className="bp__gvimg" src={giveaway.image} alt="" />}
                <div className="bp__gvprize">{giveaway.prize}</div>
              </div>
              <div className="bp__gvtimer"><span className="muted">Closes in</span> <b className={gLow ? 'low' : ''}>{gRemaining >= 10 ? Math.ceil(gRemaining) : gRemaining.toFixed(1)}s</b></div>
              <div className="bp__gvbar"><div className={`bp__gvbarfill${gLow ? ' low' : ''}`} style={{ width: `${gPct}%` }} /></div>
              <div className="bp__gvavs">
                {gRecent.slice(0, 7).map((e) => <Avatar key={e.userId} handle={e.handle} size={22} />)}
                {gCount > 7 && <span className="bp__gvmore">+{gCount - 7}</span>}
              </div>
              <button className={`btn ${gEntered ? 'btn-ghost' : 'btn-accent'} bp__gvbtn`} onClick={enter} disabled={gEntered}>
                {gEntered ? "You're in" : 'Enter giveaway'}
              </button>
            </div>
          )}
        </>
      )}

      {/* portaled celebratory overlays */}
      {spin && (
        <WheelReveal
          spin={spin}
          isMe={spin.winnerHandle === myHandle}
          onLand={(prize) => setWin({ winnerHandle: spin.winnerHandle, amount: spin.amount, title: prize.label, imageUrl: prize.imageUrl ?? item.current.image, isMe: spin.winnerHandle === myHandle })}
          onDone={() => setSpin(null)}
        />
      )}
      {win && <WinCelebration win={win} onDone={() => setWin(null)} />}
      {gWinner && <GiveawayReveal win={gWinner} isMe={!!session && gWinner.winnerUserId === session.userId} onDone={() => setGWinner(null)} />}
    </aside>
  );
}

function rejectText(reason: string): string {
  switch (reason) {
    case 'TOO_LOW': return 'Bid too low — someone beat you to it.';
    case 'INSUFFICIENT_FUNDS': return 'Not enough balance. Add funds to bid.';
    case 'AUCTION_CLOSED': return 'That auction just closed.';
    case 'RATE_LIMITED': return 'Slow down a touch, then try again.';
    default: return 'Bid not accepted — try again.';
  }
}
