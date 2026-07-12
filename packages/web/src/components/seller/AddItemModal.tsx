import { useState } from 'react';
import { createListing } from '../../api';
import ImageUpload from '../ImageUpload';
import { Tag } from '../../icons';

export default function AddItemModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [title, setTitle] = useState('');
  const [image, setImage] = useState('');
  const [startingBid, setStartingBid] = useState('1');
  const [buyNow, setBuyNow] = useState('');
  const [quantity, setQuantity] = useState('1');
  const [weight, setWeight] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await createListing({
        title: title.trim(),
        imageUrl: image || undefined,
        startingBid,
        buyNowPrice: buyNow.trim() || undefined,
        quantity: Math.max(1, Number(quantity) || 1),
        weightGrams: weight ? Math.max(1, Math.round(Number(weight))) : undefined,
      });
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.');
      setBusy(false);
    }
  };

  return (
    <div className="modal__scrim" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <button className="modal__close" onClick={onClose} aria-label="Close">×</button>
        <div className="smodal__kicker"><Tag width={15} height={15} /> New item</div>
        <h2 className="display modal__title">Add an item</h2>
        <p className="muted modal__sub">A single card, auctioned live to the highest bidder.</p>
        {error && <div className="auth__error">{error}</div>}
        <form onSubmit={submit} className="auth__form">
          <label className="auth__field">
            <span>Title</span>
            <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Charizard — Base Set Holo" required autoFocus />
          </label>
          <div className="auth__field">
            <span>Photo <em className="muted">— optional</em></span>
            <ImageUpload value={image} onChange={setImage} label="Add a photo" hint="Drag & drop or click to upload" />
          </div>
          <div className="wheel-row2">
            <label className="auth__field" style={{ flex: 1 }}>
              <span>Starting bid (USDC)</span>
              <input type="number" min="0.01" step="0.01" value={startingBid} onChange={(e) => setStartingBid(e.target.value)} required />
            </label>
            <label className="auth__field" style={{ width: 130 }}>
              <span>Quantity</span>
              <input type="number" min="1" step="1" value={quantity} onChange={(e) => setQuantity(e.target.value)} required />
            </label>
          </div>
          <label className="auth__field">
            <span>Store price (USDC) <em className="muted">— optional: lets viewers buy it now, no auction</em></span>
            <input type="number" min="0.01" step="0.01" value={buyNow} onChange={(e) => setBuyNow(e.target.value)} placeholder="e.g. 30 — appears in your shop" />
          </label>
          <label className="auth__field">
            <span>Est. shipping weight in grams <em className="muted">— used to quote UPS shipping</em></span>
            <input type="number" min="1" step="1" value={weight} onChange={(e) => setWeight(e.target.value)} placeholder="e.g. 30 (a sleeved card + mailer)" />
          </label>
          <button className="btn btn-primary btn-lg auth__submit" type="submit" disabled={busy}>
            {busy ? 'Adding…' : 'Add to listings'}
          </button>
        </form>
      </div>
    </div>
  );
}
