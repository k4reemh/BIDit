import { useState } from 'react';
import { PARCEL_PRESETS, CUSTOM_PARCEL_ID, type ParcelPreset } from '@bidit/shared';

/**
 * Package-size picker for a listing.
 *
 * Shipping is priced on size as well as weight, so "estimated weight" alone
 * cannot produce a real carrier rate. Picking a mailer off a shelf of pictures
 * is a click; measuring a polymailer with a ruler is a task nobody does, so the
 * presets are the primary path and the custom fields are folded away behind a
 * toggle.
 *
 * The value handed back is the preset ID, not a label: the id is what the listing
 * stores and what the rate cache keys on.
 */

export interface ParcelSelection {
  presetId: string;
  lengthMm?: number;
  widthMm?: number;
  heightMm?: number;
}

const MM_PER_INCH = 25.4;

/** A polymailer drawn flat, with the seam down one edge. */
const MailerIcon = ({ ratio }: { ratio: number }) => {
  const h = 30;
  const w = Math.round(h * ratio);
  const x = (44 - w) / 2;
  return (
    <svg width="44" height="34" viewBox="0 0 44 34" fill="none" aria-hidden="true">
      <rect x={x} y="2" width={w} height={h} rx="2" stroke="currentColor" strokeWidth="1.5" />
      <path d={`M${x} 8h${w}`} stroke="currentColor" strokeWidth="1.2" opacity="0.45" />
    </svg>
  );
};

/** A box drawn in isometric, sized to hint at the preset's bulk. */
const BoxIcon = ({ scale }: { scale: number }) => {
  const w = 14 + 12 * scale;
  const h = 10 + 9 * scale;
  const d = 4 + 4 * scale;
  const x = (44 - w - d) / 2;
  const y = 30 - h;
  return (
    <svg width="44" height="34" viewBox="0 0 44 34" fill="none" aria-hidden="true">
      <path
        d={`M${x} ${y} h${w} v${h} h-${w} z M${x} ${y} l${d} -${d} h${w} l-${d} ${d} M${x + w} ${y} l${d} -${d} v${h} l-${d} ${d}`}
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
    </svg>
  );
};

function PresetIcon({ preset, maxBoxVolume }: { preset: ParcelPreset; maxBoxVolume: number }) {
  if (preset.kind === 'polymailer') {
    return <MailerIcon ratio={preset.inches.length / preset.inches.width} />;
  }
  const volume = preset.inches.length * preset.inches.width * preset.inches.height;
  return <BoxIcon scale={Math.cbrt(volume / maxBoxVolume)} />;
}

const dimsLabel = (p: ParcelPreset) =>
  p.kind === 'polymailer'
    ? `${p.inches.length}" × ${p.inches.width}"`
    : `${p.inches.length}" × ${p.inches.width}" × ${p.inches.height}"`;

export default function ParcelPicker({
  value,
  onChange,
}: {
  value: ParcelSelection;
  onChange: (v: ParcelSelection) => void;
}) {
  const [custom, setCustom] = useState({ length: '', width: '', height: '' });
  const isCustom = value.presetId === CUSTOM_PARCEL_ID;

  const mailers = PARCEL_PRESETS.filter((p) => p.kind === 'polymailer');
  const boxes = PARCEL_PRESETS.filter((p) => p.kind === 'box');
  const maxBoxVolume = Math.max(...boxes.map((b) => b.inches.length * b.inches.width * b.inches.height));

  // Inches in, millimetres out. Sellers buy mailers by the inch; the rate engine
  // and every stored dimension are millimetres, so the conversion happens once,
  // here, rather than being guessed at further down.
  const setCustomDim = (key: 'length' | 'width' | 'height', raw: string) => {
    const next = { ...custom, [key]: raw };
    setCustom(next);
    const toMm = (s: string) => {
      const n = Number(s);
      return Number.isFinite(n) && n > 0 ? Math.round(n * MM_PER_INCH) : undefined;
    };
    onChange({
      presetId: CUSTOM_PARCEL_ID,
      lengthMm: toMm(next.length),
      widthMm: toMm(next.width),
      heightMm: toMm(next.height),
    });
  };

  const card = (p: ParcelPreset) => (
    <button
      key={p.id}
      type="button"
      className={`parcel-card${value.presetId === p.id ? ' is-selected' : ''}`}
      aria-pressed={value.presetId === p.id}
      onClick={() => onChange({ presetId: p.id })}
    >
      <span className="parcel-card__art">
        <PresetIcon preset={p} maxBoxVolume={maxBoxVolume} />
      </span>
      <span className="parcel-card__label">{p.label}</span>
      <span className="parcel-card__dims">{dimsLabel(p)}</span>
    </button>
  );

  return (
    <div className="parcel-picker">
      <div className="parcel-picker__head">
        <span>Estimated package size</span>
        <em className="muted">Sets the shipping quote buyers see before they bid</em>
      </div>

      <div className="parcel-picker__group">Polymailers</div>
      <div className="parcel-grid parcel-grid--3">{mailers.map(card)}</div>

      <div className="parcel-picker__group">Boxes</div>
      <div className="parcel-grid parcel-grid--4">{boxes.map(card)}</div>

      <button
        type="button"
        className={`parcel-custom__toggle${isCustom ? ' is-selected' : ''}`}
        aria-pressed={isCustom}
        onClick={() => onChange({ presetId: isCustom ? PARCEL_PRESETS[1]!.id : CUSTOM_PARCEL_ID })}
      >
        {isCustom ? 'Use a standard size instead' : 'Enter my own size'}
      </button>

      {isCustom && (
        <div className="parcel-custom">
          {(['length', 'width', 'height'] as const).map((k) => (
            <label key={k} className="auth__field parcel-custom__field">
              <span>{k[0]!.toUpperCase() + k.slice(1)} (in)</span>
              <input
                type="number"
                min="0.5"
                step="0.25"
                value={custom[k]}
                onChange={(e) => setCustomDim(k, e.target.value)}
                required
              />
            </label>
          ))}
        </div>
      )}
    </div>
  );
}
