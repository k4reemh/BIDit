import { useState } from 'react';
import { createListing, updateListing, setWheel, type SellerListing, type WheelEntryInput } from '../../api';
import ImageUpload from '../ImageUpload';
import { Dice, Plus, Trash } from '../../icons';

// `tier` isn't editable here, but a wheel made elsewhere may carry it; keeping
// it on the row means an edit round-trips it instead of silently stripping it.
interface Prize { label: string; quantity: string; image: string; tier?: string }
const blank = (): Prize => ({ label: '', quantity: '1', image: '' });

/** One prize row -> the wire entry, normalized the same way for submit and for
 *  comparing against what the listing already stores. */
const toEntry = (p: { label: string; quantity?: string; weight?: number; image?: string; imageUrl?: string; tier?: string }): WheelEntryInput => ({
  label: p.label.trim(),
  weight: Math.max(1, (p.quantity !== undefined ? Number(p.quantity) : p.weight) || 1),
  ...((p.image ?? p.imageUrl) ? { imageUrl: p.image ?? p.imageUrl } : {}),
  ...(p.tier ? { tier: p.tier } : {}),
});

/** Create a randomizer wheel, or, given `existing`, edit it: same builder,
 *  prefilled with the listing's current prizes (mirrors AddItemModal). */
export default function AddWheelModal({
  onClose,
  onCreated,
  existing,
}: {
  onClose: () => void;
  onCreated: () => void;
  existing?: SellerListing;
}) {
  const isEdit = !!existing;
  const [title, setTitle] = useState(existing?.title ?? '');
  const [startingBid, setStartingBid] = useState(existing?.startingBid ?? '1');
  const [cover, setCover] = useState(existing?.imageUrl ?? ''); // the wheel's own photo, like an item's
  const [prizes, setPrizes] = useState<Prize[]>(
    existing?.wheel?.length
      ? existing.wheel.map((w) => ({
          label: w.label,
          quantity: String(w.weight && w.weight > 0 ? w.weight : 1),
          image: w.imageUrl ?? '',
          ...(w.tier ? { tier: w.tier } : {}),
        }))
      : [blank(), blank(), blank()],
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const setPrize = (i: number, patch: Partial<Prize>) =>
    setPrizes((p) => p.map((row, idx) => (idx === i ? { ...row, ...patch } : row)));
  const addRow = () => setPrizes((p) => [...p, blank()]);
  const removeRow = (i: number) => setPrizes((p) => (p.length > 2 ? p.filter((_, idx) => idx !== i) : p));

  const valid = title.trim() && prizes.filter((p) => p.label.trim()).length >= 2;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    // Quantity = how many of this prize are in the pool → its weight, so a prize
    // with quantity 10 is 10× more likely to be won than one with quantity 1.
    const entries = prizes.filter((p) => p.label.trim()).map(toEntry);
    if (entries.length < 2) {
      setError('Add at least 2 prizes.');
      return;
    }
    setBusy(true);
    try {
      if (existing) {
        // The pool write is the guarded call (the server refuses it once a spin
        // has sold, so odds can't be restocked mid-run). Send it only when the
        // prizes actually changed, and first, so a refusal doesn't half-apply
        // the edit; name/photo/bid edits alone stay possible on a selling wheel.
        const before = JSON.stringify((existing.wheel ?? []).map(toEntry));
        if (JSON.stringify(entries) !== before) await setWheel(existing.id, entries);
        await updateListing(existing.id, { title: title.trim(), imageUrl: cover, startingBid });
      } else {
        const listing = await createListing({
          title: title.trim(),
          startingBid,
          ...(cover ? { imageUrl: cover } : {}),
        });
        await setWheel(listing.id, entries);
      }
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong. Try again.');
      setBusy(false);
    }
  };

  return (
    <div className="modal__scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal modal--wide" onClick={(e) => e.stopPropagation()}>
        <button className="modal__close" onClick={onClose} aria-label="Close">×</button>
        <div className="smodal__kicker smodal__kicker--wheel"><Dice width={15} height={15} /> Randomizer</div>
        <h2 className="display modal__title">{isEdit ? 'Edit randomizer' : 'Add a randomizer wheel'}</h2>
        <p className="muted modal__sub">
          {isEdit
            ? 'Change the prizes, odds, name, or photo. Once a spin has sold, the prize pool is locked; the name, photo, and bid stay editable.'
            : 'Buyers bid for one roll. The wheel spins on close and picks their prize.'}
        </p>
        {error && <div className="auth__error">{error}</div>}
        <form onSubmit={submit} className="auth__form">
          <div className="wheel-row2">
            <label className="auth__field" style={{ flex: 2 }}>
              <span>Wheel name</span>
              <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Destined Rivals mystery wheel" required autoFocus />
            </label>
            <label className="auth__field" style={{ width: 150 }}>
              <span>Starting bid (USDC)</span>
              <input type="number" min="0.01" step="0.01" value={startingBid} onChange={(e) => setStartingBid(e.target.value)} required />
            </label>
          </div>

          <label className="auth__field">
            <span>Wheel photo <span className="muted">(optional)</span></span>
            <ImageUpload
              value={cover}
              onChange={setCover}
              label="Drag a photo here, or click to upload"
              hint="Shown on the wheel's card and while bidding, just like an item."
            />
          </label>

          <div className="wheel-build">
            <div className="wheel-build__head wheel-build__head--v2">
              <span>Photo</span><span>Prize</span><span>Qty</span><span />
            </div>
            {prizes.map((p, i) => (
              <div className="wheel-build__row wheel-build__row--v2" key={i}>
                {/* Thumbnail-sized: prize art ships inside the spin broadcast,
                    and renders no larger than a reel row. */}
                <ImageUpload value={p.image} onChange={(v) => setPrize(i, { image: v })} compact max={220} quality={0.75} />
                <input className="wb-label" value={p.label} onChange={(e) => setPrize(i, { label: e.target.value })} placeholder={i === 0 ? 'Charizard ex Alt Art' : 'Prize name'} />
                <input className="wb-qty" value={p.quantity} onChange={(e) => setPrize(i, { quantity: e.target.value.replace(/[^0-9]/g, '') })} placeholder="1" inputMode="numeric" title="How many in the pool. More copies, better odds." />
                <button type="button" className="wb-del" onClick={() => removeRow(i)} disabled={prizes.length <= 2} aria-label="Remove"><Trash width={16} height={16} /></button>
              </div>
            ))}
            <button type="button" className="wheel-build__add" onClick={addRow}><Plus width={15} height={15} /> Add prize</button>
          </div>
          <p className="muted" style={{ fontSize: 12.5, marginTop: -4 }}>Quantity is how many of that prize are in the pool. More copies means better odds of landing on it.</p>

          <button className="btn btn-primary btn-lg auth__submit" type="submit" disabled={!valid || busy}>
            {busy ? (isEdit ? 'Saving…' : 'Creating…') : isEdit ? 'Save changes' : 'Create wheel'}
          </button>
        </form>
      </div>
    </div>
  );
}
