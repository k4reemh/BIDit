import { useEffect, useState, lazy, Suspense } from 'react';
import { useParams } from 'react-router-dom';
import BidPanel from '../components/BidPanel';
import ChatPanel from '../components/ChatPanel';
import BidTip from '../components/BidTip';
import Avatar from '../components/Avatar';
import ShopOverlay from '../components/ShopOverlay';
import { Bag, Verified, Theater, TheaterExit } from '../icons';

// livekit-client is heavy, only load it on the watch page (and only this chunk).
const PumpStream = lazy(() => import('../components/PumpStream'));
import { resolveCoin, getPumpCoin, type ResolvedRoom, type PumpCoin, type Session } from '../api';

/**
 * In-site watch + bid page for a pump.fun coin. Left: a stream "theater" showing
 * the coin's art + whether the seller is live on pump.fun (their video can't be
 * embedded (it's frame-blocked and behind a viewer token) so we link out).
 * Right: the always-on BidPanel, where the auction/giveaway runs on OUR backend,
 * so people can bid without the extension (and from regions where pump.fun is
 * blocked).
 */
export default function Watch({ session, onAuth }: { session: Session | null; onAuth: () => void }) {
  const { coin = '' } = useParams();
  const [resolved, setResolved] = useState<ResolvedRoom | null | undefined>(undefined); // undefined = loading
  const [pump, setPump] = useState<PumpCoin | null>(null);
  const [shopOpen, setShopOpen] = useState(false);
  // Theatre mode: 'off' is the normal page, 'on' widens the stage to the full
  // window with the bid panel still alongside, and 'wide' shrinks the panel
  // further when the stream wants even more room. Desktop only (CSS ignores it
  // under 1000px, where the panel already stacks below the stream).
  const [theater, setTheater] = useState<'off' | 'on' | 'wide'>('off');

  // Esc leaves theatre mode, the way every video player behaves.
  useEffect(() => {
    if (theater === 'off') return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setTheater('off'); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [theater]);

  useEffect(() => {
    let alive = true;
    setResolved(undefined);
    setPump(null);
    resolveCoin(coin).then((r) => alive && setResolved(r));
    getPumpCoin(coin).then((p) => alive && setPump(p)).catch(() => {});
    return () => { alive = false; };
  }, [coin]);

  const pumpUrl = `https://pump.fun/coin/${coin}`;
  const title = pump?.name || 'Live stream';
  const sellerHandle = resolved?.sellerHandle;

  return (
    <main className={`watch${theater === 'off' ? ' container' : ` watch--theater watch--${theater}`}`}>
      <div className="watch__grid">
        <section className="watch__stage">
          <div className="theater">
            <Suspense fallback={<div className="pstream__cover"><span className="muted">Loading stream…</span></div>}>
            <PumpStream
              mint={coin}
              offline={
                <>
                  {pump?.image
                    ? <img className="theater__art" src={pump.image} alt="" />
                    : <div className="theater__art theater__art--ph" />}
                  <div className="theater__scrim" />
                  <div className="theater__center">
                    <div className="theater__eyebrow">{sellerHandle ? `@${sellerHandle} isn’t streaming here right now` : 'Not streaming right now'}</div>
                    <p className="theater__note">When they go live on pump.fun, the stream plays here automatically. No extension needed. Bidding happens in the panel →</p>
                    <a className="btn btn-ghost" href={pumpUrl} target="_blank" rel="noreferrer">Open on pump.fun ↗</a>
                  </div>
                </>
              }
            />
            </Suspense>
            <div className="theater__top">
              {sellerHandle && (
                <span className="theater__seller">
                  <Avatar handle={sellerHandle} src={resolved?.sellerAvatar} size={22} /> @{sellerHandle}
                  {resolved?.verified && (
                    <span className="vpill" title="Verified seller">
                      <Verified width={11} height={11} /> Verified
                    </span>
                  )}
                </span>
              )}
              {sellerHandle && (
                <button className="theater__shop" onClick={() => setShopOpen(true)} aria-label="Open the seller's shop" title="Shop: buy without bidding">
                  <Bag width={16} height={16} /> Shop
                </button>
              )}
              <div className="theater__modes">
                {theater !== 'off' && (
                  <button
                    className="theater__mode"
                    onClick={() => setTheater(theater === 'on' ? 'wide' : 'on')}
                    title={theater === 'on' ? 'Give the stream more room' : 'Give the bid panel more room'}
                    aria-label={theater === 'on' ? 'Widen the stream' : 'Restore the bid panel'}
                  >
                    {theater === 'on' ? '⟨⟩' : '⟩⟨'}
                  </button>
                )}
                <button
                  className="theater__mode"
                  onClick={() => setTheater(theater === 'off' ? 'on' : 'off')}
                  title={theater === 'off' ? 'Theatre mode' : 'Exit theatre mode (Esc)'}
                  aria-label={theater === 'off' ? 'Theatre mode' : 'Exit theatre mode'}
                  aria-pressed={theater !== 'off'}
                >
                  {theater === 'off' ? <Theater width={17} height={17} /> : <TheaterExit width={17} height={17} />}
                </button>
              </div>
            </div>
          </div>
          <div className="watch__meta">
            <h1 className="display watch__title">{title}</h1>
            <div className="watch__coin">{coin}</div>
            {pump?.description && <p className="muted watch__desc">{pump.description}</p>}
          </div>
        </section>

        <div className="watch__side">
          {resolved === undefined ? (
            <aside className="bp">
              <div className="bp__head"><span className="bp__brand">Live bidding</span></div>
              <p className="muted" style={{ padding: 16, fontSize: 13.5 }}>Connecting…</p>
            </aside>
          ) : resolved === null ? (
            <aside className="bp">
              <div className="bp__head"><span className="bp__brand">Live bidding</span></div>
              <div className="bp__empty">
                <b>No BIDit seller here yet</b>
                <p>This coin isn’t linked to a BIDit seller, so there’s nothing to bid on. If it’s your coin, link it in Seller → Settings.</p>
              </div>
            </aside>
          ) : (
            <>
              <BidTip />
              <BidPanel room={resolved.room} session={session} onAuth={onAuth} />
              <ChatPanel room={resolved.room} session={session} onAuth={onAuth} />
            </>
          )}
        </div>
      </div>

      {shopOpen && sellerHandle && (
        <ShopOverlay coin={coin} sellerHandle={sellerHandle} sellerVerified={resolved?.verified} session={session} onAuth={onAuth} onClose={() => setShopOpen(false)} />
      )}
    </main>
  );
}
