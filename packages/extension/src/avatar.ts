/** Deterministic gradient avatar from a handle — no backend, no image fetch. */
const PALETTE: ReadonlyArray<readonly [string, string]> = [
  ['#22e0a1', '#4f8cff'],
  ['#9b6bff', '#4f8cff'],
  ['#ff7a45', '#ff4d6d'],
  ['#22e0a1', '#9b6bff'],
  ['#ffb020', '#ff7a45'],
  ['#4f8cff', '#22e0a1'],
  ['#ff4d6d', '#9b6bff'],
  ['#36c8ff', '#22e0a1'],
];

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

export function avatarColors(handle: string): readonly [string, string] {
  return PALETTE[hash(handle) % PALETTE.length]!;
}

/** A gradient circle with the handle's initial — sized in px. */
export function makeAvatar(handle: string, size = 24): HTMLElement {
  const [a, b] = avatarColors(handle);
  const node = document.createElement('div');
  node.style.cssText =
    `width:${size}px;height:${size}px;border-radius:50%;` +
    `background:linear-gradient(135deg,${a},${b});` +
    `display:flex;align-items:center;justify-content:center;flex:none;` +
    `color:#08121f;font-weight:800;font-size:${Math.round(size * 0.46)}px;`;
  node.textContent = (handle.trim()[0] ?? '?').toUpperCase();
  return node;
}
