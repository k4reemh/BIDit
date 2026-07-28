// API base. Defaults to the local dev backend; override at runtime with
// localStorage 'bidit_api', or at build time with VITE_API (set in Vercel).
const ls = typeof localStorage !== 'undefined' ? localStorage.getItem('bidit_api') : null;
const raw = (ls || (import.meta.env.VITE_API as string | undefined) || 'http://localhost:8787').trim().replace(/\/$/, '');
// Tolerate VITE_API given without a scheme (e.g. "bidit-backend.onrender.com").
export const API: string = /^https?:\/\//.test(raw) ? raw : `https://${raw}`;

/**
 * Resolve an image reference from the API.
 *
 * The backend serves uploads as files under /media/... rather than inlining
 * base64 in list payloads, and returns those paths relative to the API host.
 * Absolute URLs (pump.fun art) and any leftover data URLs pass through, so
 * callers can hand this anything and get something an <img src> accepts.
 */
export function mediaSrc(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  if (/^(https?:|data:)/.test(value)) return value;
  return value.startsWith('/media/') ? `${API}${value}` : value;
}
