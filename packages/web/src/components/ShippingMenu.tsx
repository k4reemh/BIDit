import { useState } from 'react';
import { createPortal } from 'react-dom';
import { updateMe, money2, type ShippingMode, type ListingShipEstimate } from '../api';
import { Truck, Shield, Bookmark, Check } from '../icons';

const OPTIONS: {
  mode: ShippingMode;
  Icon: typeof Truck;
  title: string;
  sub: string;
  rec?: boolean;
  tag?: string;
  soon?: boolean;
}[] = [
  {
    mode: 'SHIP_LATER',
    Icon: Bookmark,
    title: 'Buy now, ship later',
    rec: true,
    sub: 'Skip shipping costs until you’re ready. The seller stores your wins for up to 14 days, then ships when you say go.',
  },
  {
    mode: 'PRIVATE',
    Icon: Shield,
    title: 'Private secure shipping',
    tag: 'Premium',
    sub: 'A small premium for privacy: the seller ships to us without ever seeing your address, and we forward it on to you.',
  },
  {
    // Shipping is only paid from Ready to ship for now, so the mode that charges
    // on win is shown but not selectable.
    mode: 'WEEKLY_BUNDLE',
    Icon: Truck,
    title: 'Ship to my address',
    soon: true,
    sub: 'Pay shipping once on your first win of the week, then everything else that week ships free.',
  },
];

/**
 * The shipping panel behind the truck icon on the bid panel.
 *
 * It also carries the shipping estimate, which used to sit under the bid itself.
 * A number that moves with the item competes with the clock and the price for
 * attention during a live auction; here it is one tap away for the people who
 * want it and out of the way for everyone else.
 */
export default function ShippingMenu({
  value,
  estimate,
  onClose,
  onChange,
}: {
  value: ShippingMode;
  estimate?: ListingShipEstimate | null;
  onClose: () => void;
  onChange: (m: ShippingMode) => void;
}) {
  const [sel, setSel] = useState<ShippingMode>(value);
  const [busy, setBusy] = useState(false);

  const pick = async (m: ShippingMode, soon?: boolean) => {
    if (soon || m === sel || busy) return;
    setSel(m);
    onChange(m);
    setBusy(true);
    try {
      await updateMe({ shippingMode: m });
    } finally {
      setBusy(false);
    }
  };

  // Portal to <body>: rendered inline it lives inside the sticky .watch__side
  // stacking context, which traps the fixed scrim BELOW the livestream overlay.
  return createPortal(
    <div className="modal__scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal shipmenu" onClick={(e) => e.stopPropagation()}>
        <button className="modal__close" onClick={onClose} aria-label="Close">×</button>
        <div className="smodal__kicker"><Truck width={15} height={15} /> Shipping</div>
        <h2 className="display modal__title">How you get your wins</h2>
        <p className="muted modal__sub">Pick how your wins ship. Change it anytime.</p>

        {estimate && (
          <div className={`shipest${estimate.isFrom ? ' shipest--from' : ''}`}>
            <div className="shipest__row">
              <span className="muted">{estimate.isFrom ? 'Shipping from' : 'Estimated shipping'}</span>
              <b>~${money2(estimate.shippingFee)}</b>
            </div>
            <p className="shipest__note">
              {estimate.isFrom
                ? 'Add a delivery address in your account to see your own rate.'
                : 'An estimate for this item to your saved address. You pay the exact amount later, from Ready to ship.'}
            </p>
          </div>
        )}

        <div className="shipopts">
          {OPTIONS.map((o) => (
            <button
              key={o.mode}
              className={`shipopt${sel === o.mode ? ' on' : ''}${o.soon ? ' soon' : ''}`}
              onClick={() => pick(o.mode, o.soon)}
              disabled={busy || o.soon}
              aria-disabled={o.soon || undefined}
            >
              <span className="shipopt__ic"><o.Icon width={20} height={20} /></span>
              <span className="shipopt__body">
                <span className="shipopt__title">
                  {o.title}
                  {o.rec && !o.soon && <em className="shipopt__rec">Recommended</em>}
                  {o.tag && !o.soon && <em className="shipopt__tag">{o.tag}</em>}
                  {o.soon && <em className="shipopt__soon">Coming soon</em>}
                </span>
                <span className="shipopt__sub">{o.sub}</span>
              </span>
              {!o.soon && (
                <span className={`shipopt__radio${sel === o.mode ? ' on' : ''}`}>
                  {sel === o.mode && <Check width={13} height={13} />}
                </span>
              )}
            </button>
          ))}
        </div>
      </div>
    </div>,
    document.body,
  );
}
