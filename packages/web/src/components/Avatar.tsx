import { useState } from 'react';

export default function Avatar({
  handle,
  size = 32,
  hue,
  ring,
  src,
}: {
  handle: string;
  size?: number;
  hue?: number;
  ring?: boolean;
  /** Uploaded profile photo (data URL or https). Falls back to the gradient. */
  src?: string | null;
}) {
  const [failed, setFailed] = useState(false);
  const common = {
    width: size,
    height: size,
    flex: 'none' as const,
    borderRadius: '50%',
    boxShadow: ring ? '0 0 0 2px rgba(255,255,255,0.14)' : 'none',
  };

  if (src && !failed) {
    return <img src={src} alt="" onError={() => setFailed(true)} style={{ ...common, objectFit: 'cover', display: 'block' }} />;
  }

  let h = 0;
  for (let i = 0; i < handle.length; i++) h = (h * 31 + handle.charCodeAt(i)) >>> 0;
  const a = hue ?? h % 360;
  const b = (a + 50 + ((h >> 8) % 90)) % 360;
  return (
    <span
      style={{
        ...common,
        background: `linear-gradient(135deg, hsl(${a} 75% 56%), hsl(${b} 78% 48%))`,
        display: 'grid',
        placeItems: 'center',
        color: 'rgba(255,255,255,0.95)',
        fontWeight: 800,
        fontSize: size * 0.42,
      }}
    >
      {handle.replace(/[^a-z0-9]/gi, '').charAt(0).toUpperCase() || '?'}
    </span>
  );
}
