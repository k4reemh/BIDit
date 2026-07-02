import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import BidPanel from '../components/BidPanel';
import Avatar from '../components/Avatar';
import { resolveCoin, getPumpCoin, type ResolvedRoom, type PumpCoin, type Session } from '../api';

/**
 * In-site watch + bid page for a pump.fun coin. Left: a stream "theater" showing
 * the coin's art + whether the seller is live on pump.fun (their video can't be
 * embedded — it's frame-blocked and behind a viewer token — so we link out).
 * Right: the always-on BidPanel, where the auction/giveaway runs on OUR backend,
 * so people can bid without the extension (and from regions where pump.fun is
 * blocked).
 */
export default function Watch({ session, onAuth }: { session: Session | null; onAuth: () => void }) {
  const { coin = '' } = useParams();
  const [resolved, setResolved] = useState<ResolvedRoom | null | undefined>(undefined); // undefined = loading
  const [pump, setPump] = useState<PumpCoin | null>(null);

  useEffect(() => {
    let alive = true;
    setResolved(undefined);
    setPump(null);
    resolveCoin(coin).then((r) => alive && setResolved(r));
    getPumpCoin(coin).then((p) => alive && setPump(p)).catch(() => {});
    return () => { alive = false; };
  }, [coin]);

  const pumpUrl = `https://pump.fun/coin/${coin}`;
  const live = pump?.isLive === true;
  const title = pump?.name || 'Live stream';
  const sellerHandle = resolved?.sellerHandle;

  return (
    <main className="container watch">
      <div className="watch__grid">
        <section className="watch__stage">
          <div className="theater">
            {pump?.image
              ? <img className="theater__art" src={pump.image} alt="" />
              : <div className="theater__art theater__art--ph" />}
            <div className="theater__scrim" />
            <div className="theater__top">
              <span className={`live-badge${live ? '' : ' off'}`}>{live ? <><span className="dot" /> LIVE</> : 'OFFLINE'}</span>
              {sellerHandle && <span className="theater__seller"><Avatar handle={sellerHandle} size={22} /> @{sellerHandle}</span>}
            </div>
            <div className="theater__center">
              {live ? (
                <>
                  <div className="theater__eyebrow">● Streaming now on pump.fun</div>
                  <a className="btn btn-primary btn-lg" href={pumpUrl} target="_blank" rel="noreferrer">Open the live video ↗</a>
                  <p className="theater__note">Watch on pump.fun — bid right here on BIDit.</p>
                </>
              ) : (
                <>
                  <div className="theater__eyebrow">{sellerHandle ? `@${sellerHandle} isn’t live right now` : 'Not live right now'}</div>
                  <p className="theater__note">When the seller goes live on pump.fun, it shows here. Bidding still happens in the panel →</p>
                  <a className="btn btn-ghost" href={pumpUrl} target="_blank" rel="noreferrer">View coin on pump.fun ↗</a>
                </>
              )}
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
            <BidPanel room={resolved.room} session={session} onAuth={onAuth} />
          )}
        </div>
      </div>
    </main>
  );
}
