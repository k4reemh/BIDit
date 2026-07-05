import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import Avatar from './Avatar';
import { runConfetti } from '../lib/confetti';
import type { RandomizerSpin, ReelSlot } from '../realtime';

/**
 * The randomizer wheel reveal (portaled to body) — a vertical slot reel that
 * decelerates onto the prize. A pure replay of the server's RANDOMIZER_SPIN
 * (reel / targetIndex / durationMs / startsAt), so it matches the on-stream
 * overlay. On settle it calls onLand with the prize, then onDone.
 *
 * Polish over the plain reel: velocity-mapped motion blur while it's flying, a
 * small overshoot that springs back so it *clicks* onto the prize, a winning-row
 * pop + band flare, and a confetti burst on land — all transform/opacity driven
 * to stay smooth (the blur is deduped to coarse steps so it never thrashes).
 */
const ROW_H = 62;
const CENTER_SLOT = 2;
const OVERSHOOT = 16; // px the reel sails past the prize before springing back
const easeOutQuart = (p: number): number => 1 - Math.pow(1 - p, 4);
const easeOutCubic = (p: number): number => 1 - Math.pow(1 - p, 3);

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
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [prize, setPrize] = useState<ReelSlot | null>(null);
  const [leaving, setLeaving] = useState(false);

  useEffect(() => {
    const offset = spin.serverNow - Date.now();
    const strip = stripRef.current;
    const startY = CENTER_SLOT * ROW_H;
    const endY = (CENTER_SLOT - spin.targetIndex) * ROW_H;
    const landedSlot = spin.reel[spin.targetIndex] ?? spin.reel[spin.reel.length - 1]!;
    // Only overshoot when there's a row beyond the target to scroll into, so the
    // spring-back never reveals empty space under the window.
    const overshoot = spin.targetIndex < spin.reel.length - 1 ? OVERSHOOT : 0;
    const sailY = endY - overshoot;
    let raf = 0;
    let done = false;
    let prevY = startY;
    let lastBlur = -1;

    const setBlur = (v: number) => {
      const b = Math.round(Math.min(7, v * 0.16) * 2) / 2; // dedupe to 0.5px steps
      if (b === lastBlur || !strip) return;
      lastBlur = b;
      strip.style.filter = b > 0.4 ? `blur(${b}px)` : 'none';
    };

    const finish = () => {
      if (done) return;
      done = true;
      if (strip) {
        strip.style.transform = `translate3d(0, ${endY}px, 0)`;
        strip.style.filter = 'none';
      }
      setPrize(landedSlot);
      runConfetti(canvasRef.current, ['#22e0a1', '#4f8cff', '#f5c518', '#ff7a45', '#ffffff'], 96, 3800);
      window.setTimeout(() => onLand(landedSlot), 850);
      window.setTimeout(() => setLeaving(true), 1600);
      window.setTimeout(onDone, 2050);
    };

    const frame = () => {
      const elapsed = Date.now() + offset - spin.startsAt;
      const p = Math.max(0, Math.min(1, elapsed / spin.durationMs));
      // Fly to just-past the prize for the first 90%, then spring the last 16px back.
      const y =
        p < 0.9
          ? startY + (sailY - startY) * easeOutQuart(p / 0.9)
          : sailY + (endY - sailY) * easeOutCubic((p - 0.9) / 0.1);
      setBlur(Math.abs(y - prevY));
      prevY = y;
      if (strip) strip.style.transform = `translate3d(0, ${y}px, 0)`;
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
      <canvas ref={canvasRef} className="wr__confetti" aria-hidden />
      <div className={`wr__card${leaving ? ' wr__card--out' : ''}`}>
        <div className="wr__brand"><span>BID</span>it · Wheel</div>
        <div className="wr__who"><Avatar handle={spin.winnerHandle} size={22} /> {isMe ? 'Spinning for you' : `Rolling for @${spin.winnerHandle}`}</div>
        <div className={`wr__window${prize ? ' wr__window--land' : ''}`}>
          <div className={`wr__band${prize ? ' wr__band--land' : ''}`} />
          <span className="wr__tick wr__tick--l" aria-hidden />
          <span className="wr__tick wr__tick--r" aria-hidden />
          <div className="wr__strip" ref={stripRef}>
            {spin.reel.map((slot, i) => (
              <div className={`wr__row${prize && i === spin.targetIndex ? ' wr__row--win' : ''}`} key={i}>
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
        <div className={`wr__prize${prize ? ' wr__prize--show' : ''}`}>{prize ? `${prize.label}` : ''}</div>
        <div className="wr__fair"><i /> Provably fair · seed <code>{spin.seedHash.slice(0, 10)}…</code></div>
      </div>
    </div>,
    document.body,
  );
}
