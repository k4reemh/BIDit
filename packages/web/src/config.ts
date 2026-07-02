// API base. Defaults to the local dev backend; override at runtime with
// localStorage 'bidit_api', or at build time with VITE_API (set in Vercel).
const ls = typeof localStorage !== 'undefined' ? localStorage.getItem('bidit_api') : null;
const raw = (ls || (import.meta.env.VITE_API as string | undefined) || 'http://localhost:8787').trim().replace(/\/$/, '');
// Tolerate VITE_API given without a scheme (e.g. "bidit-backend.onrender.com").
export const API: string = /^https?:\/\//.test(raw) ? raw : `https://${raw}`;
