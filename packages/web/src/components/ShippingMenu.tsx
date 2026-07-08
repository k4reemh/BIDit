import { useState } from 'react';
import { updateMe, type ShippingMode } from '../api';
import { Truck, Shield, Bookmark, Check } from '../icons';

const OPTIONS: { mode: ShippingMode; Icon: typeof Truck; title: string; sub: string; rec?: boolean; tag?: string }[] = [
  {
    mode: 'WEEKLY_BUNDLE',
    Icon: Truck,
    title: 'Ship to my address',
    sub: 'Pay shipping once on your first auction win — then no extra shipping on any wins after, for the rest of the week.',
  },
  {
    mode: 'PRIVATE',
    Icon: Shield,
    title: 'Private secure shipping',
    tag: 'Premium',
    sub: 'A small premium for privacy: the seller ships to us without ever seeing your address, and we forward it on to you.',
  },
  {
    mode: 'SHIP_LATER',
    Icon: Bookmark,
    title: 'Buy now, ship later',
    rec: true,
    sub: 'Skip shipping costs until you’re ready — the seller stores your wins for up to 14 days, then ships when you say go.',
  },
];

/** The shipping-preference picker opened from the bid panel. Auto-saves the
 *  buyer's choice; WEEKLY_BUNDLE keeps the weekly-bundle opt-in in sync. */
export default function ShippingMenu({
  value,
  onClose,
  onChange,
}: {
  value: ShippingMode;
  onClose: () => void;
  onChange: (m: ShippingMode) => void;
}) {
  const [sel, setSel] = useState<ShippingMode>(value);
  const [busy, setBusy] = useState(false);

  const pick = async (m: ShippingMode) => {
    if (m === sel || busy) return;
    setSel(m);
    onChange(m);
    setBusy(true);
    try {
      await updateMe({ shippingMode: m });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal__scrim" onClick={onClose}>
      <div className="modal shipmenu" onClick={(e) => e.stopPropagation()}>
        <button className="modal__close" onClick={onClose} aria-label="Close">×</button>
        <div className="smodal__kicker"><Truck width={15} height={15} /> Shipping</div>
        <h2 className="display modal__title">How you get your wins</h2>
        <p className="muted modal__sub">Pick how the items you win are shipped to you. You can change this anytime.</p>

        <div className="shipopts">
          {OPTIONS.map((o) => (
            <button key={o.mode} className={`shipopt${sel === o.mode ? ' on' : ''}`} onClick={() => pick(o.mode)} disabled={busy}>
              <span className="shipopt__ic"><o.Icon width={20} height={20} /></span>
              <span className="shipopt__body">
                <span className="shipopt__title">
                  {o.title}
                  {o.rec && <em className="shipopt__rec">Recommended</em>}
                  {o.tag && <em className="shipopt__tag">{o.tag}</em>}
                </span>
                <span className="shipopt__sub">{o.sub}</span>
              </span>
              <span className={`shipopt__radio${sel === o.mode ? ' on' : ''}`}>{sel === o.mode && <Check width={13} height={13} />}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
