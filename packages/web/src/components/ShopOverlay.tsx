import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { getShop, buyShopItem, refreshMe, type ShopItem, type Session } from '../api';
import { Bag, Check } from '../icons';

/**
 * The seller's shop, opened from the watch page: fixed-price items viewers can
 * buy outright — no bidding. A buy is two taps (Buy → Confirm), charged from the
 * buyer's available USDC balance, and ships exactly like an auction win.
 */
export default function ShopOverlay({
  coin,
  sellerHandle,
  session,
  onAuth,
  onClose,
  onSession,
}: {
  coin: string;
  sellerHandle: string;
  session: Session | null;
  onAuth: () => void;
  onClose: () => void;
  onSession?: (s: Session) => void;
}) {
  const [items, setItems] = useState<ShopItem[] | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null); // listingId awaiting confirm
  const [buying, setBuying] = useState<string | null>(null);
  const [boughtTitle, setBoughtTitle] = useState<string | null>(null);
  const [error, setError] = useState('');

  const load = () => getShop(coin).then((s) => setItems(s.items)).catch(() => setItems([]));
  useEffect(() => { load(); }, [coin]); // eslint-disable-line react-hooks/exhaustive-deps

  const buy = async (item: ShopItem) => {
    if (!session) return onAuth();
    setBuying(item.id);
    setError('');
    try {
      await buyShopItem(item.id);
      setBoughtTitle(item.title);
      setConfirming(null);
      load(); // stock changed
      if (onSession) refreshMe().then((s) => s && onSession(s)).catch(() => {}); // new balance
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Purchase failed');
      setConfirming(null);
    } finally {
      setBuying(null);
    }
  };

  return (
    <div className="modal__scrim shop__scrim" onClick={onClose}>
      <div className="shop" onClick={(e) => e.stopPropagation()}>
        <button className="modal__close" onClick={onClose} aria-label="Close">×</button>
        <div className="shop__head">
          <span className="shop__ic"><Bag width={18} height={18} /></span>
          <div>
            <h2 className="shop__title">@{sellerHandle}’s shop</h2>
            <p className="muted shop__sub">Buy it now — no bidding. Paid from your balance, ships like a win.</p>
          </div>
        </div>

        {boughtTitle && (
          <div className="shop__done">
            <Check width={16} height={16} /> <b>{boughtTitle}</b> is yours! Track it in{' '}
            <Link to="/ship" onClick={onClose}>Ready to ship</Link>.
          </div>
        )}
        {error && (
          <div className="shop__err">
            {error}
            {/insufficient/i.test(error) && <> · <Link to="/deposit" onClick={onClose}>Add funds</Link></>}
          </div>
        )}

        {items === null ? (
          <p className="muted shop__note">Loading the shop…</p>
        ) : items.length === 0 ? (
          <div className="shop__empty">
            <Bag width={24} height={24} />
            <b>Nothing in the shop right now</b>
            <p className="muted">@{sellerHandle} hasn’t priced anything for instant buy — catch the live auctions instead.</p>
          </div>
        ) : (
          <div className="shop__grid">
            {items.map((it) => (
              <div className="shop__item" key={it.id}>
                <div className="shop__thumb">
                  {it.image ? <img src={it.image} alt="" loading="lazy" /> : <span className="shop__ph"><Bag width={20} height={20} /></span>}
                  {it.quantity > 1 && <span className="shop__qty">×{it.quantity}</span>}
                </div>
                <div className="shop__ititle" title={it.title}>{it.title}</div>
                <div className="shop__row">
                  <span className="shop__price">${it.price}</span>
                  {confirming === it.id ? (
                    <span className="shop__confirm">
                      <button className="btn btn-accent btn-sm" disabled={buying === it.id} onClick={() => buy(it)}>
                        {buying === it.id ? 'Buying…' : `Confirm $${it.price}`}
                      </button>
                      <button className="btn btn-ghost btn-sm" disabled={buying === it.id} onClick={() => setConfirming(null)}>✕</button>
                    </span>
                  ) : (
                    <button
                      className="btn btn-primary btn-sm"
                      onClick={() => (session ? setConfirming(it.id) : onAuth())}
                    >
                      {session ? 'Buy now' : 'Sign in to buy'}
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
