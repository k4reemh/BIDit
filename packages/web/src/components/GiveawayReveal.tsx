import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import Avatar from './Avatar';
import { runConfetti } from '../lib/confetti';
import type { GiveawayWinner } from '../realtime';

/**
 * The giveaway winner reveal — a full-screen celebratory overlay, rendered via a
 * portal to <body> so it's never trapped behind a page's stacking/overflow
 * context. A horizontal avatar strip hops through the entrants and settles on the
 * winner (pure function of the server's GIVEAWAY_WINNER), then a gold winner card
 * + confetti.
 */
const TILE_W = 96;
const CENTER_TILES = 2;
const easeOutQuart = (p: number): number => 1 - Math.pow(1 - p, 4);

export default function GiveawayReveal({
  win,
  isMe,
  onDone,
}: {
  win: GiveawayWinner;
  isMe: boolean;
  onDone: () => void;
}) {
  const stripRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [landed, setLanded] = useState(false);
  const [leaving, setLeaving] = useState(false);

  useEffect(() => {
    const offset = win.serverNow - Date.now();
    const startX = CENTER_TILES * TILE_W;
    const endX = (CENTER_TILES - win.targetIndex) * TILE_W;
    let raf = 0;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      if (stripRef.current) stripRef.current.style.transform = `translateX(${endX}px)`;
      setLanded(true);
      runConfetti(canvasRef.current);
      window.setTimeout(() => setLeaving(true), 5600);
      window.setTimeout(onDone, 6050);
    };
    const frame = () => {
      const elapsed = Date.now() + offset - win.startsAt;
      const p = Math.max(0, Math.min(1, elapsed / win.durationMs));
      const x = startX + (endX - startX) * easeOutQuart(p);
      if (stripRef.current) stripRef.current.style.transform = `translateX(${x}px)`;
      if (p >= 1) finish();
      else raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    // Fallback so the reveal always completes even if rAF is paused (backgrounded tab).
    const fb = window.setTimeout(finish, Math.max(0, win.startsAt + win.durationMs - (Date.now() + offset) + 250));
    return () => { cancelAnimationFrame(raf); clearTimeout(fb); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [win.giveawayId]);

  const kindLabel = win.kind === 'BUYER_ONLY' ? 'Buyers only' : 'Everyone';

  return createPortal(
    <div className="gvr">
      <canvas ref={canvasRef} className="gvr__confetti" />
      <div className={`gvr__card${landed ? ' gvr__card--win' : ''}${leaving ? ' gvr__card--out' : ''}`}>
        <div className="gvr__brand"><b>Giveaway</b> · <span className="gvr__kind">{kindLabel}</span></div>
        {win.image && <img className="gvr__prizeimg" src={win.image} alt="" />}
        <div className="gvr__prize">{win.prize}</div>

        <div className="gvr__reel">
          <div className="gvr__spot" />
          <div className="gvr__strip" ref={stripRef}>
            {win.roll.map((e, i) => (
              <div className="gvr__tile" key={i}>
                <Avatar handle={e.handle} size={66} />
                <span className="gvr__h">@{e.handle}</span>
              </div>
            ))}
          </div>
          <div className="gvr__fade gvr__fade--l" />
          <div className="gvr__fade gvr__fade--r" />
        </div>

        {landed && (
          <div className="gvr__win">
            <Avatar handle={win.winnerHandle} size={70} />
            <div className="gvr__kick">{isMe ? 'You won!' : 'Winner'}</div>
            <div className="gvr__head">{isMe ? 'YOU WON!' : `@${win.winnerHandle}`}</div>
            <div className="gvr__wprize">wins <b>{win.prize}</b></div>
            <div className="gvr__meta">{win.entrantCount} {win.entrantCount === 1 ? 'entry' : 'entries'}</div>
            <div className="gvr__fair"><i /> Provably fair · seed <code>{win.seedHash.slice(0, 10)}…</code></div>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
