# BIDit

**Live trading-card auctions on Pump.fun livestreams — bid in real time, settle in USDC.**

BIDit turns a Pump.fun stream into a live auction house. Sellers run rapid-fire
auctions and randomizer wheels on their coin's stream; viewers bid in real time
from the web app or a browser overlay; every sale settles in USDC on Solana, with
a slice of each sale routed to a $BID buyback.

- **Real-time and fair** — server-authoritative bidding with anti-snipe: a
  late bid extends the clock, so there are no last-second snipes.
- **USDC-settled on Solana** — deposits, bids, and payouts all run on real USDC.
- **Money that can't drift** — every balance is derived from an append-only,
  double-entry ledger. The total across all accounts is invariantly zero, so a
  bug can't create or destroy funds.
- **Runs where the audience already is** — a browser overlay injects the auction
  panel onto a live Pump.fun coin page, and the same auctions play on the web app.

---

## How it works

**Buyers** — deposit USDC, join a live stream, and bid. Funds are only reserved
while you're the high bidder and charged when you win. Win it, pay shipping, and
it ships to you.

**Sellers** — link your Pump.fun coin, queue your cards, and fire auctions one at
a time while you stream. Get paid in USDC. Fulfill ten orders to earn a Verified
Seller badge.

## Architecture

A TypeScript monorepo with three layers over a shared domain package:

| Package | What it is |
| --- | --- |
| `@bidit/backend` | The engine — auctions, timers, the ledger, escrow, the real-time WebSocket server, and the Solana USDC rails. Node + Prisma (PostgreSQL). |
| `@bidit/web` | The consumer web app — homepage, live watch/bid page, buyer and seller dashboards, admin. React + Vite. |
| `@bidit/extension` | A Manifest V3 browser overlay that renders the auction panel on a Pump.fun coin page. |
| `@bidit/shared` | Domain enums, the money type, and the wire protocol — one source of truth so the layers can't drift. |

**The server is authoritative.** Clients render state and send intents; they
never decide balances, timers, or bid validity. A single server clock drives
every deadline, so anti-snipe and auction close are deterministic and tested
against a manual clock with zero sleeping.

**The ledger.** `Account` has no balance column — balance is always derived:

```
available = settled − active_holds
settled   = SUM(ledger.amount for the account)
```

Every operation is double-entry (legs sum to zero), amounts are `bigint`
micro-units rather than floats, and balance-changing writes take a row lock and
re-check funds inside the transaction — so overdrafts and double-spends are
impossible by construction.

**Money rails.** USDC deposits, withdrawals, and payouts run through a
`ChainClient` interface: a deterministic in-memory chain powers the test suite,
and a real Solana implementation (`@solana/web3.js`) runs in production. The
ledger stays the source of truth; the on-chain layer swaps in behind the
interface without touching auction logic.

## Repo layout

```
packages/
  shared/      domain enums · money helpers · realtime protocol
  backend/     Prisma schema · ledger · auction engine · WS server · Solana rails · tests
  web/         React + Vite consumer app (homepage, live page, dashboards, admin)
  extension/   Manifest V3 overlay for Pump.fun pages
```

## Run it locally

No Docker or system Postgres required — an embedded PostgreSQL runs inside the
project.

```bash
npm install        # installs deps and generates the Prisma client
npm test           # boots embedded PG, pushes the schema, runs the full suite
npm run dev        # dev server at http://localhost:8787  ( / · /seller · /admin )
```

Build the extension with `npm -w @bidit/extension run build`, then load
`packages/extension/dist/` unpacked at `chrome://extensions`.

## Testing

The backend ships with 160+ tests, including a **property test** that checks the
ledger against a reference model for conservation and non-negativity, a
**concurrency test** proving no double-spend under parallel bids, and an
**enum-drift test** that keeps the shared types and the database schema in
lockstep.

```bash
npm test
```

## Deployment

The backend deploys to Render (blueprint in [`render.yaml`](render.yaml)) with a
managed Postgres; the web app deploys to Vercel.

## Status

BIDit is in early access. The auction engine, real-time layer, web app,
extension, seller flow, and USDC settlement rails are built and tested. The
current release pays sellers directly on a sale; the delivery-gated escrow flow
and the non-custodial on-chain program are the next milestones.

## License

© 2026 BIDit — all rights reserved. See [`LICENSE`](LICENSE).
