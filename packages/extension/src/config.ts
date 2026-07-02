/** Backend endpoints. Dev points at the local server; later chunks read these
 *  from extension storage / a build-time constant for staging + prod. */
export const BACKEND_HTTP = 'http://localhost:8787';
export const BACKEND_WS = 'ws://localhost:8787/ws';

/** How a Pump.fun coin address is read from the page URL. */
export const COIN_URL_RE = /\/coin\/([^/?#]+)/;
