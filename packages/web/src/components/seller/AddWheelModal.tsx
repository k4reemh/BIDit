import { useState } from 'react';
import { createListing, setWheel } from '../../api';
import ImageUpload from '../ImageUpload';
import { Dice, Plus, Trash } from '../../icons';

interface Prize { label: string; quantity: string; image: string }
const blank = (): Prize => ({ label: '', quantity: '1', image: '' });

export default function AddWheelModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [title, setTitle] = useState('');
  const [startingBid, setStartingBid] = useState('1');
  const [prizes, setPrizes] = useState<Prize[]>([blank(), blank(), blank()]);
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
    const entries = prizes
      .filter((p) => p.label.trim())
      .map((p) => ({
        label: p.label.trim(),
        weight: Math.max(1, Number(p.quantity) || 1),
        ...(p.image ? { imageUrl: p.image } : {}),
      }));
    if (entries.length < 2) {
      setError('Add at least 2 prizes.');
      return;
    }
    setBusy(true);
    try {
      const listing = await createListing({ title: title.trim(), startingBid });
      await setWheel(listing.id, entries);
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.');
      setBusy(false);
    }
  };

  return (
    <div className="modal__scrim" onClick={onClose}>
      <div className="modal modal--wide" onClick={(e) => e.stopPropagation()}>
        <button className="modal__close" onClick={onClose} aria-label="Close">×</button>
        <div className="smodal__kicker smodal__kicker--wheel"><Dice width={15} height={15} /> Randomizer</div>
        <h2 className="display modal__title">Add a randomizer wheel</h2>
        <p className="muted modal__sub">Buyers bid for one roll — the wheel spins on close and assigns their prize.</p>
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

          <div className="wheel-build">
            <div className="wheel-build__head wheel-build__head--v2">
              <span>Photo</span><span>Prize</span><span>Qty</span><span />
            </div>
            {prizes.map((p, i) => (
              <div className="wheel-build__row wheel-build__row--v2" key={i}>
                <ImageUpload value={p.image} onChange={(v) => setPrize(i, { image: v })} compact />
                <input className="wb-label" value={p.label} onChange={(e) => setPrize(i, { label: e.target.value })} placeholder={i === 0 ? 'Charizard ex — Alt Art' : 'Prize name'} />
                <input className="wb-qty" value={p.quantity} onChange={(e) => setPrize(i, { quantity: e.target.value.replace(/[^0-9]/g, '') })} placeholder="1" inputMode="numeric" title="How many in the pool — higher = more likely" />
                <button type="button" className="wb-del" onClick={() => removeRow(i)} disabled={prizes.length <= 2} aria-label="Remove"><Trash width={16} height={16} /></button>
              </div>
            ))}
            <button type="button" className="wheel-build__add" onClick={addRow}><Plus width={15} height={15} /> Add prize</button>
          </div>
          <p className="muted" style={{ fontSize: 12.5, marginTop: -4 }}>Quantity = how many of that prize are in the pool. A prize with a higher quantity is more likely to be won.</p>

          <button className="btn btn-primary btn-lg auth__submit" type="submit" disabled={!valid || busy}>
            {busy ? 'Creating…' : 'Create wheel'}
          </button>
        </form>
      </div>
    </div>
  );
}
