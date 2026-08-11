# BIDit extension — release / store notes

**v1.1.0** — re-launch build. The extension floats the BIDit auction panel over a
Pump.fun coin/stream page so viewers can bid in USDC without leaving the stream.

## Build

```bash
npm run build                 # production (biditsol.com + hosted backend)
BIDIT_BACKEND=http://localhost:8787 BIDIT_WEB=http://localhost:5174 npm run build   # local dev
```

Output is `dist/` (load unpacked in `chrome://extensions`, or zip for the Web Store).
A store zip is produced with `cd dist && zip -qr ../bidit-extension-v<ver>.zip .`.

## What v1.1.0 fixes (from the dormant 2026-07-29 build)

- **Secure WS handshake.** Connects via a one-time `/realtime/ticket` instead of a
  raw session token in the socket URL (keeps the 30-day token out of logs).
- **Graceful session expiry.** A revoked/expired session (web logout, ban, or a
  30-day-old token) now signs the user out and prompts re-login, instead of
  looping "connecting…" forever. Reconnects use exponential backoff.
- **New-user onboarding.** The popup now links out to the website to create an
  account, add funds, reset a password, and verify email — a brand-new user is no
  longer stuck at a login-only screen.
- **Email-verify awareness.** An unverified account (whose bids the server rejects)
  sees a "confirm your email" prompt in both the popup and the panel, and the bid
  controls are disabled until it can actually bid.
- **Signed-out clarity.** The panel shows "sign in via the BIDit icon" and disables
  bidding, so a click never silently no-ops.
- **Store readiness.** Real 16/48/128 icons + `action.default_icon`, tightened
  name/description, version bump.

## Chrome Web Store listing

- **Name:** BIDit — Live card auctions on Pump.fun
- **Summary:** Bid on live trading-card auctions right on Pump.fun streams. Settle
  in USDC, held in escrow until it ships.
- **Category:** Shopping
- **Privacy:** the extension stores only the session token locally; it makes no
  requests except to the BIDit backend. Link the published privacy policy
  (biditsol.com/privacy) in the listing. Justify permissions: `storage` (remember
  the sign-in), host access to `pump.fun` (inject the panel) and the BIDit backend
  (bids + auction data).

## Backend config to check before announcing

- **`BIDIT_TRUST_PROXY=1`** in the Render dashboard. Without it, the auth rate
  limiter keys on Render's shared load-balancer IP, so all users share one
  10-attempts/min login budget and can hit spurious 429s. This affects the website
  too, not just the extension. (One hop = Render's proxy.)
