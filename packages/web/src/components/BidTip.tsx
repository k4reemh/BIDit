import { useState } from 'react';
import { X, Bolt, Check } from '../icons';

const KEY = 'bidit_tip_bid';

/** First-run coach card above the bid panel — teaches how bidding works, right
 *  where you do it. Dismissible; the choice sticks. */
export default function BidTip() {
  const [show, setShow] = useState(() => localStorage.getItem(KEY) !== '1');
  if (!show) return null;
  const dismiss = () => { localStorage.setItem(KEY, '1'); setShow(false); };
  return (
    <div className="bidtip">
      <button className="bidtip__x" onClick={dismiss} aria-label="Dismiss">
        <X width={14} height={14} />
      </button>
      <div className="bidtip__h"><Bolt width={16} height={16} /> New here? How bidding works</div>
      <ul className="bidtip__list">
        <li><Check width={14} height={14} /> Tap to bid — you’re only charged if you <b>win</b>. Bids just reserve funds.</li>
        <li><Check width={14} height={14} /> A late bid <b>extends the clock</b> — no last-second snipes.</li>
        <li><Check width={14} height={14} /> Win it and it lands in <b>Ready to ship</b>.</li>
      </ul>
    </div>
  );
}
