import { useRef, useState } from 'react';
import { Camera, X } from '../icons';

/** Read an image file, downscale it, and return a compressed data URL — so photos
 *  can be stored inline (no upload infra) without bloating the DB. */
async function fileToDataUrl(file: File, max = 900, quality = 0.82): Promise<string> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('no canvas');
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close?.();
  return canvas.toDataURL('image/jpeg', quality);
}

/** Drag-and-drop / click-to-upload image picker. Stores a compressed data URL. */
export default function ImageUpload({
  value,
  onChange,
  label = 'Photo',
  hint,
  compact = false,
}: {
  value: string;
  onChange: (v: string) => void;
  label?: string;
  hint?: string;
  compact?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [drag, setDrag] = useState(false);
  const [busy, setBusy] = useState(false);

  const take = async (file?: File | null) => {
    if (!file || !file.type.startsWith('image/')) return;
    setBusy(true);
    try {
      onChange(await fileToDataUrl(file));
    } catch {
      /* ignore */
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className={`imgup${compact ? ' imgup--compact' : ''}${drag ? ' imgup--drag' : ''}${value ? ' imgup--has' : ''}`}
      onClick={() => !value && inputRef.current?.click()}
      onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
      onDragLeave={() => setDrag(false)}
      onDrop={(e) => { e.preventDefault(); setDrag(false); void take(e.dataTransfer.files?.[0]); }}
    >
      <input ref={inputRef} type="file" accept="image/*" hidden onChange={(e) => void take(e.target.files?.[0])} />
      {value ? (
        <>
          <img src={value} alt="" className="imgup__preview" />
          <button
            type="button"
            className="imgup__remove"
            onClick={(e) => { e.stopPropagation(); onChange(''); }}
            aria-label="Remove photo"
          >
            <X width={14} height={14} />
          </button>
        </>
      ) : (
        <div className="imgup__empty">
          <Camera width={compact ? 18 : 22} height={compact ? 18 : 22} />
          {!compact && <><span className="imgup__label">{busy ? 'Processing…' : label}</span>{hint && <span className="imgup__hint">{hint}</span>}</>}
        </div>
      )}
    </div>
  );
}
