import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import Avatar from './Avatar';
import type { RandomizerSpin, ReelSlot } from '../realtime';

/**
 * The randomizer wheel reveal (portaled to body) — a vertical slot reel that
 * decelerates onto the prize. A pure replay of the server's RANDOMIZER_SPIN
 * (reel / targetIndex / durationMs / startsAt), so it matches the on-stream
 * overlay. On settle it calls onLand with the prize, then onDone.
 */
const ROW_H = 62;
const WINDOW_ROWS = 5;
const CENTER_SLOT = 2;
const easeOutQuart = (p: number): number => 1 - Math.pow(1 - p, 4);

export default function WheelReveal({
  spin,
  isMe,
  onLand,
  onDone,
}: {
  spin: RandomizerSpin;
  isMe: boolean;
  onLand: (prize: ReelSlot) => void;
  onDone: () => void;
}) {
  const stripRef = useRef<HTMLDivElement>(null);
  const [prize, setPrize] = useState<ReelSlot | null>(null);
  const [leaving, setLeaving] = useState(false);

  useEffect(() => {
    const offset = spin.serverNow - Date.now();
    const startY = CENTER_SLOT * ROW_H;
    const endY = (CENTER_SLOT - spin.targetIndex) * ROW_H;
    const landedSlot = spin.reel[spin.targetIndex] ?? spin.reel[spin.reel.length - 1]!;
    let raf = 0;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      if (stripRef.current) stripRef.current.style.transform = `translateY(${endY}px)`;
      setPrize(landedSlot);
      window.setTimeout(() => onLand(landedSlot), 850);
      window.setTimeout(() => setLeaving(true), 1500);
      window.setTimeout(onDone, 1950);
    };
    const frame = () => {
      const elapsed = Date.now() + offset - spin.startsAt;
      const p = Math.max(0, Math.min(1, elapsed / spin.durationMs));
      const y = startY + (endY - startY) * easeOutQuart(p);
      if (stripRef.current) stripRef.current.style.transform = `translateY(${y}px)`;
      if (p >= 1) finish();
      else raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    // Fallback so the reveal always completes even if rAF is paused (backgrounded tab).
    const fb = window.setTimeout(finish, Math.max(0, spin.startsAt + spin.durationMs - (Date.now() + offset) + 250));
    return () => { cancelAnimationFrame(raf); clearTimeout(fb); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spin.auctionId]);

  return createPortal(
    <div className="wr">
      <div className={`wr__card${leaving ? ' wr__card--out' : ''}`}>
        <div className="wr__brand"><span>BID</span>it · Wheel</div>
        <div className="wr__who"><Avatar handle={spin.winnerHandle} size={22} /> {isMe ? 'Spinning for you' : `Rolling for @${spin.winnerHandle}`}</div>
        <div className="wr__window">
          <div className={`wr__band${prize ? ' wr__band--land' : ''}`} />
          <div className="wr__strip" ref={stripRef}>
            {spin.reel.map((slot, i) => (
              <div className="wr__row" key={i}>
                {slot.imageUrl
                  ? <img className="wr__thumb" src={slot.imageUrl} alt="" />
                  : <span className="wr__dot" />}
                <span className="wr__name">{slot.label}</span>
              </div>
            ))}
          </div>
          <div className="wr__fade wr__fade--t" />
          <div className="wr__fade wr__fade--b" />
        </div>
        <div className={`wr__prize${prize ? ' wr__prize--show' : ''}`}>{prize ? `🎉 ${prize.label}` : ''}</div>
        <div className="wr__fair"><i /> Provably fair · seed <code>{spin.seedHash.slice(0, 10)}…</code></div>
      </div>
    </div>,
    document.body,
  );
}
