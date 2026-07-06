/** Light/dark theme. Dark = the "Navy Immersive" scheme (navy surfaces, white
 *  text, orange stays). The choice is a `data-theme` attribute on <html> that
 *  flips the CSS color tokens; persisted in localStorage. */
export type Theme = 'light' | 'dark';
const KEY = 'bidit_theme';

export function getTheme(): Theme {
  // Dark by default (the Navy Immersive scheme); only an explicit 'light' choice opts out.
  return localStorage.getItem(KEY) === 'light' ? 'light' : 'dark';
}

export function applyTheme(t: Theme): void {
  document.documentElement.dataset.theme = t;
  // Keep the mobile browser / status-bar chrome color in sync with the theme.
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', t === 'light' ? '#f4f6fa' : '#050a14');
}

export function setTheme(t: Theme): void {
  localStorage.setItem(KEY, t);
  applyTheme(t);
}

/** Apply the saved theme ASAP (called before React renders, to avoid a flash). */
export function initTheme(): void {
  applyTheme(getTheme());
}

/** Flip and persist; returns the new theme. */
export function toggleTheme(): Theme {
  const next: Theme = getTheme() === 'dark' ? 'light' : 'dark';
  setTheme(next);
  return next;
}
