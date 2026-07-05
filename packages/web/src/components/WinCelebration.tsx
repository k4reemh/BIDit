import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import Avatar from './Avatar';
import { runConfetti } from '../lib/confetti';

export interface WinInfo {
  winnerHandle: string;
  amount: string;
  title: string;
  imageUrl: string | null;
  isMe: boolean;
}

/** Full-screen auction-win celebration (portaled to body). "YOU WON" if it's the
 *  viewer, otherwise "@x won", with the item, price and the $BID buyback tie-in. */
export default function WinCelebration({ win, onDone }: { win: WinInfo; onDone: () => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [leaving, setLeaving] = useState(false);

  useEffect(() => {
    runConfetti(
      canvasRef.current,
      win.isMe ? ['#f5c518', '#0e9f6e', '#4f8cff', '#ff7a45', '#ffffff'] : ['#0e9f6e', '#4f8cff', '#9b6bff'],
      win.isMe ? 190 : 110,
      4200,
    );
    const t1 = window.setTimeout(() => setLeaving(true), 3900);
    const t2 = window.setTimeout(onDone, 4350);
    return () => { clearTimeout(t1); clearTimeout(t2); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const pumped = (parseFloat(win.amount) * 0.05 || 0).toFixed(2);

  return createPortal(
    <div className="wc">
      <canvas ref={canvasRef} className="gvr__confetti" />
      <div className={`wc__card${win.isMe ? ' wc__card--me' : ''}${leaving ? ' wc__card--out' : ''}`}>
        <div className="wc__av"><Avatar handle={win.winnerHandle} size={74} /></div>
        <div className="wc__kick">{win.isMe ? 'You won' : 'Sold'}</div>
        <div className="wc__head">{win.isMe ? 'WINNER!' : `@${win.winnerHandle} won`}</div>
        <div className="wc__item">
          {win.imageUrl && <img src={win.imageUrl} alt="" />}
          <span>{win.title}</span>
        </div>
        <div className="wc__price">${win.amount}</div>
        <div className="wc__buyback">+${pumped} → <b>$BID</b> buyback</div>
      </div>
    </div>,
    document.body,
  );
}
