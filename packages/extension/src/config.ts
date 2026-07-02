/** Backend endpoints. Baked in at build time from BIDIT_BACKEND (see build.mjs);
 *  defaults to the hosted Render backend so a friend's unpacked build "just works".
 *  For local dev: `BIDIT_BACKEND=http://localhost:8787 npm run build`. */
declare const __BIDIT_BACKEND__: string;

const HTTP = __BIDIT_BACKEND__.replace(/\/$/, '');
export const BACKEND_HTTP = HTTP;
export const BACKEND_WS = `${HTTP.replace(/^http/, 'ws')}/ws`;

/** How a Pump.fun coin address is read from the page URL. */
export const COIN_URL_RE = /\/coin\/([^/?#]+)/;
