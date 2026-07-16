import { useState } from 'react';
import ImageUpload from './ImageUpload';
import { disputeShipment, type Fulfillment } from '../api';

const REASONS = [
  { code: 'not_arrived', label: 'It never arrived', sub: 'Tracking says delivered, but you don’t have it' },
  { code: 'damaged', label: 'Arrived damaged', sub: 'The card or packaging was damaged in transit' },
  { code: 'wrong_item', label: 'Wrong item', sub: 'You received a different card than you won' },
  { code: 'not_as_described', label: 'Not as described', sub: 'Condition or details don’t match the listing' },
  { code: 'other', label: 'Something else', sub: 'A different problem — tell us what happened' },
];

export default function DisputeModal({
  shipmentId,
  onClose,
  onResolved,
}: {
  shipmentId: string;
  onClose: () => void;
  onResolved: (f: Fulfillment) => void;
}) {
  const [step, setStep] = useState<1 | 2>(1);
  const [reason, setReason] = useState('');
  const [detail, setDetail] = useState('');
  const [photos, setPhotos] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const reasonLabel = REASONS.find((r) => r.code === reason)?.label ?? '';

  const submit = async () => {
    if (!detail.trim()) { setErr('Add a short description of the problem.'); return; }
    setBusy(true); setErr('');
    try {
      const f = await disputeShipment(shipmentId, { reason, detail: detail.trim(), photos });
      onResolved(f);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not submit your report.');
      setBusy(false);
    }
  };

  return (
    <div className="modal__scrim" onClick={onClose}>
      <div className="modal modal--wide" onClick={(e) => e.stopPropagation()}>
        <button className="modal__close" onClick={onClose} aria-label="Close">×</button>

        {step === 1 ? (
          <>
            <h2 className="modal__title">What went wrong?</h2>
            <p className="modal__sub muted">Pick the closest match — you’ll add details and photos next.</p>
            <div className="dispute__reasons">
              {REASONS.map((r) => (
                <button key={r.code} className="dispute__reason" onClick={() => { setReason(r.code); setStep(2); }}>
                  <span className="dispute__reason-txt"><b>{r.label}</b><span className="muted">{r.sub}</span></span>
                  <span className="dispute__chev" aria-hidden>›</span>
                </button>
              ))}
            </div>
          </>
        ) : (
          <>
            <button className="dispute__back" onClick={() => { setStep(1); setErr(''); }}>‹ Back</button>
            <h2 className="modal__title">{reasonLabel}</h2>
            <p className="modal__sub muted">Describe what happened. Clear photos help us resolve it fast.</p>

            <div className="fld">
              <label>What happened?</label>
              <textarea rows={4} value={detail} onChange={(e) => setDetail(e.target.value)} placeholder="Tell us the details — what you expected and what you got…" />
            </div>

            <div className="fld">
              <label>Photos <span className="muted">— optional, up to 4</span></label>
              <div className="dispute__photos">
                {photos.map((p, i) => (
                  <div key={i} className="dispute__photo">
                    <img src={p} alt="" />
                    <button type="button" onClick={() => setPhotos((ps) => ps.filter((_, j) => j !== i))} aria-label="Remove photo">×</button>
                  </div>
                ))}
                {photos.length < 4 && (
                  <ImageUpload value="" onChange={(url) => url && setPhotos((ps) => [...ps, url].slice(0, 4))} compact label="Add photo" hint="" />
                )}
              </div>
            </div>

            {err && <div className="auth__error">{err}</div>}
            <div className="acct-actions">
              <button className="btn btn-primary" disabled={busy} onClick={submit}>{busy ? 'Submitting…' : 'Submit report'}</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
