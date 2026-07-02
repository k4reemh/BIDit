export default function Avatar({
  handle,
  size = 32,
  hue,
  ring,
}: {
  handle: string;
  size?: number;
  hue?: number;
  ring?: boolean;
}) {
  let h = 0;
  for (let i = 0; i < handle.length; i++) h = (h * 31 + handle.charCodeAt(i)) >>> 0;
  const a = hue ?? h % 360;
  const b = (a + 50 + ((h >> 8) % 90)) % 360;
  return (
    <span
      style={{
        width: size,
        height: size,
        flex: 'none',
        borderRadius: '50%',
        background: `linear-gradient(135deg, hsl(${a} 75% 56%), hsl(${b} 78% 48%))`,
        display: 'grid',
        placeItems: 'center',
        color: 'rgba(255,255,255,0.95)',
        fontWeight: 800,
        fontSize: size * 0.42,
        boxShadow: ring ? '0 0 0 2px rgba(255,255,255,0.14)' : 'none',
      }}
    >
      {handle.replace(/[^a-z0-9]/gi, '').charAt(0).toUpperCase() || '?'}
    </span>
  );
}
