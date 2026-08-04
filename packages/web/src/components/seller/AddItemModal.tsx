import { useState } from 'react';
import { DEFAULT_PARCEL_ID, findParcelPreset } from '@bidit/shared';
import { createListing, updateListing, type SellerListing } from '../../api';
import ImageUpload from '../ImageUpload';
import ParcelPicker, { type ParcelSelection } from './ParcelPicker';
import { Tag } from '../../icons';

/** Create a listing, or, given `existing`, edit it in place. One component so
 *  the two forms cannot drift: an editable field here is an editable field
 *  there, prefilled with what the listing already says. */
export default function AddItemModal({
  onClose,
  onCreated,
  existing,
}: {
  onClose: () => void;
  onCreated: () => void;
  existing?: SellerListing;
}) {
  const [title, setTitle] = useState(existing?.title ?? '');
  const [image, setImage] = useState(existing?.imageUrl ?? '');
  const [startingBid, setStartingBid] = useState(existing?.startingBid ?? '1');
  const [buyNow, setBuyNow] = useState('');
  const [quantity, setQuantity] = useState(String(existing?.quantity ?? 1));
  const [weight, setWeight] = useState(existing?.weightGrams != null ? String(existing.weightGrams) : '');
  const [parcel, setParcel] = useState<ParcelSelection>(
    existing?.parcelPreset
      ? { presetId: existing.parcelPreset, ...(existing.parcel ?? {}) }
      : { presetId: DEFAULT_PARCEL_ID },
  );
  const isEdit = !!existing;
  const isWheel = !!existing?.wheel;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  // Picking a package suggests what it usually weighs loaded. Only ever a
  // prefill: it fills an empty field and never overwrites a number the seller
  // typed, because their scale beats our guess.
  const pickParcel = (v: ParcelSelection) => {
    setParcel(v);
    if (!weight) {
      const preset = findParcelPreset(v.presetId);
      if (preset) setWeight(String(preset.typicalGrams));
    }
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const customDims =
        parcel.lengthMm || parcel.widthMm || parcel.heightMm
          ? { lengthMm: parcel.lengthMm, widthMm: parcel.widthMm, heightMm: parcel.heightMm }
          : undefined;
      if (existing) {
        await updateListing(existing.id, {
          title: title.trim(),
          imageUrl: image,
          startingBid,
          quantity: isWheel ? undefined : Math.max(1, Number(quantity) || 1),
          weightGrams: weight ? Math.max(1, Math.round(Number(weight))) : null,
          parcelPreset: parcel.presetId,
          parcel: customDims,
        });
      } else {
        await createListing({
          title: title.trim(),
          imageUrl: image || undefined,
          startingBid,
          buyNowPrice: buyNow.trim() || undefined,
          quantity: Math.max(1, Number(quantity) || 1),
          weightGrams: weight ? Math.max(1, Math.round(Number(weight))) : undefined,
          parcelPreset: parcel.presetId,
          parcel: customDims,
        });
      }
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong. Try again.');
      setBusy(false);
    }
  };

  return (
    <div className="modal__scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <button className="modal__close" onClick={onClose} aria-label="Close">×</button>
        <div className="smodal__kicker"><Tag width={15} height={15} /> {isEdit ? 'Edit item' : 'New item'}</div>
        <h2 className="display modal__title">{isEdit ? 'Edit listing' : 'Add an item'}</h2>
        <p className="muted modal__sub">
          {isEdit
            ? 'Changes apply to future auctions and shop sales. Items already won are unaffected.'
            : 'A single card, auctioned live to the highest bidder.'}
        </p>
        {error && <div className="auth__error">{error}</div>}
        <form onSubmit={submit} className="auth__form">
          <label className="auth__field">
            <span>Title</span>
            <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Base Set Charizard Holo" required autoFocus />
          </label>
          <div className="auth__field">
            <span>Photo <em className="muted">(optional)</em></span>
            <ImageUpload value={image} onChange={setImage} label="Add a photo" hint="Drag & drop or click to upload" />
          </div>
          <div className="wheel-row2">
            <label className="auth__field" style={{ flex: 1 }}>
              <span>Starting bid (USDC)</span>
              <input type="number" min="0.01" step="0.01" value={startingBid} onChange={(e) => setStartingBid(e.target.value)} required />
            </label>
            <label className="auth__field" style={{ width: 130 }}>
              <span>Quantity</span>
              <input
                type="number" min="1" step="1" value={quantity}
                onChange={(e) => setQuantity(e.target.value)}
                disabled={isWheel}
                title={isWheel ? 'A randomizer’s quantity comes from its prizes' : undefined}
                required
              />
            </label>
          </div>
          {!isEdit && (
            <label className="auth__field">
              <span>Store price (USDC) <em className="muted">· optional, lets viewers buy it now without an auction</em></span>
              <input type="number" min="0.01" step="0.01" value={buyNow} onChange={(e) => setBuyNow(e.target.value)} placeholder="e.g. 30, appears in your shop" />
            </label>
          )}
          <label className="auth__field">
            <span>Est. shipping weight in grams <em className="muted">· packed, including the mailer</em></span>
            <input type="number" min="1" step="1" value={weight} onChange={(e) => setWeight(e.target.value)} placeholder="e.g. 30 (a sleeved card + mailer)" />
          </label>
          <ParcelPicker value={parcel} onChange={pickParcel} />
          <button className="btn btn-primary btn-lg auth__submit" type="submit" disabled={busy}>
            {busy ? 'Saving…' : isEdit ? 'Save changes' : 'Add to listings'}
          </button>
        </form>
      </div>
    </div>
  );
}
