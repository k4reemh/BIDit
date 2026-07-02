/** Internal messaging between the UI (content script + popup) and the background
 *  service worker. Distinct from the server wire protocol (@bidit/shared). */
import type { ServerMessage } from '@bidit/shared';

export const PORT_NAME = 'bidit';

/** UI -> service worker. */
export type UiToSw =
  | { cmd: 'HELLO'; coin: string } // content script announces the coin on its page
  | { cmd: 'BID'; auctionId: string; amount: string; nonce: string }
  | { cmd: 'GIVEAWAY_ENTER'; giveawayId: string } // viewer taps Enter on a giveaway
  | { cmd: 'EMAIL_LOGIN'; email: string; password: string } // popup (real login)
  | { cmd: 'SET_SESSION'; token: string; handle: string; userId: string } // popup (wallet sign-in)
  | { cmd: 'LOGOUT' }
  | { cmd: 'PING' }; // keep the service worker alive

/** Service worker -> UI. */
export type SwToUi =
  | { evt: 'STATUS'; connected: boolean; handle: string | null }
  | { evt: 'ROOM'; coin: string; room: string | null; sellerHandle?: string }
  | { evt: 'SERVER'; message: ServerMessage } // authoritative server message, passed through
  | { evt: 'AUTH_ERROR'; message: string } // login failed (shown in the popup)
  | { evt: 'PONG' };
