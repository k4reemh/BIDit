# BIDit

A live auction marketplace for trading cards — Whatnot-style auction mechanics
run on top of Pump.fun livestreams, settled in USDC, with a platform cut routed
to $BID buybacks.

> Build status: **Chunks 1–7 — through real USDC rails.** Real accounts; the
> money flow is wired to Solana (custodial v1) and verified against a simulated
> chain — the live devnet run is via [docs/DEVNET.md](docs/DEVNET.md). Backend
> suite: 81 tests.
>
> Try it live: `npm run dev` → open http://localhost:8787 in two tabs, log in as
> different handles, deposit, and bid — or load the extension (below) and run it
> on a real Pump.fun page.

## Architecture (target)

Three components with clean boundaries:

1. **Backend (the engine)** — source of truth for auctions, timers, bids,
   balances, orders, escrow. Node + TypeScript, Postgres (Prisma), Redis (later),
   WebSocket (later). _The server is authoritative; the client decides nothing._
2. **Extension (the shell)** — injects the auction UI onto a Pump.fun stream
   page. A thin client. _(Later chunk.)_
3. **Escrow module (walled off)** — one `EscrowProvider` interface, a dev wallet
   impl now, an on-chain impl later. _(Later chunk.)_

## Monorepo layout

```
packages/
  shared/    @bidit/shared  — domain enums + money helpers (no drift between layers)
  backend/   @bidit/backend — Prisma schema + the ledger engine + tests
```

## The ledger (Chunk 1)

The single most important design decision: **`Account` has no balance column.**
Balance is always derived from append-only `LedgerEntry` rows.

```
available_balance = settled_balance - active_holds
settled_balance   = SUM(ledger.amount WHERE accountId = account)
active_holds      = funds locked as current high bidder   (Chunk 3; 0 today)
```

Every operation is **double-entry**: legs sum to exactly zero. Deposits and
withdrawals balance against a system `EXTERNAL` account; the 5% platform fee
balances the buyer→seller split. As a result the grand total across all accounts
is invariantly `0` — money can't be created or destroyed by a bug.

- Money is `bigint` micro-units (USDC, 6 decimals). Never floats.
- Overdrafts are impossible: balance-changing ops take a `SELECT … FOR UPDATE`
  row lock and re-check available funds inside the transaction.
- Deposits are idempotent via an optional `idempotencyKey`.

## Running it

No Docker or system Postgres required — `embedded-postgres` runs a real
PostgreSQL 17 inside the project. From the repo root:

```bash
npm install            # also generates the Prisma client
npm test               # boots embedded PG, pushes schema, runs the full suite
npm run demo           # narrated walk-through with simulated money
```

`npm test` covers: unit tests (deposit / withdraw / refund / 95-5 split /
idempotency / money parsing), a **property test** that checks the engine against
a reference model with conservation + non-negativity invariants, a
**concurrency test** proving no double-spend under parallel debits, and an
**enum-drift test** keeping `@bidit/shared` and the Prisma schema in lockstep.

## The auction engine (Chunk 2)

Server-authoritative live auctions with Whatnot-style anti-snipe, built on the
ledger and still on simulated money.

- **One clock.** The server clock is the only clock (`src/clock.ts`); deadlines
  are server timestamps. Tests drive a `ManualClock`, so timer behaviour is
  verified deterministically with zero sleeping.
- **Atomic bid pipeline** (`placeBid`): exists → RUNNING & not past `endsAt` →
  clears min-next-bid → not already leading → balance check, all in one
  transaction. Rejections carry a typed reason (`BID_TOO_LOW`,
  `INSUFFICIENT_BALANCE`, `ALREADY_LEADING`, `AUCTION_ENDED`, …).
- **Holds** (`Hold` table): leading an auction locks the bid amount;
  `available = settled − ACTIVE holds`. Two row locks taken in a fixed order
  (Auction → bidder Account) serialize per-auction bids and a single user's
  bids across auctions — so nobody can lead auctions worth more than they hold.
- **Server-driven close** (`closeDueAuctions` / `AuctionScheduler`): polls for
  due auctions and re-checks the deadline under lock, so a late extending bid is
  never closed early. Never driven by a client message.

## The real-time layer (Chunk 3)

A WebSocket server (`src/realtime/`) that pushes authoritative state and accepts
bid intents. The wire protocol lives in `@bidit/shared` so the server and the
(future) extension can't drift.

- **Client → server:** `SUBSCRIBE` / `UNSUBSCRIBE` (room = sellerId), `BID_INTENT`.
- **Server → client:** `AUCTION_STATE`, `BID_ACCEPTED`, `BID_REJECTED` (only to
  the bidder), `AUCTION_CLOSED`, `BALANCE_UPDATE`. Every state-changing message
  carries `serverNow` so clients correct for clock skew and never drift.
- A `BID_INTENT` runs the **exact** Chunk 2 `placeBid` pipeline — the transport
  re-implements nothing. Accepts broadcast to the room; balance updates go to the
  new bidder and the freed prior leader.
- **Fan-out** through a pluggable `RealtimeBus`: `InMemoryBus` (one instance) or
  `RedisBus` (ioredis, multi-instance) behind one interface, keyed by
  `room:`/`user:` channels. Per-user `BID_INTENT` rate limiting.

Run `npm run dev` for the embedded-PG-backed server + a dumb test page at
http://localhost:8787 — the literal "two browser tabs bidding" demo.

## The extension (Chunk 4)

A Manifest V3 extension (`packages/extension/`) that renders the auction UI on a
Pump.fun coin page — the actual product surface.

- **Content script** detects `pump.fun/coin/<address>`, reads the coin, and
  injects the panel into an isolated **shadow root** floating over the page
  (fail-soft fixed position; logs a video-anchor miss if Pump's layout shifts).
- **Background service worker** owns the WebSocket + REST. Pump's page CSP can't
  block it, and the UI can only reach the server *through* it — so the client is
  genuinely thin (no balance math, no timer authority, no bid validation).
- **Popup** = stub login, deposit, connection status.
- The coin address maps to a seller's room via `GET /resolve?coin=` (a seller's
  `pumpCoinAddress` links their stream to their BIDit auctions).

```bash
npm -w @bidit/extension run build        # -> packages/extension/dist/
```

Then load `packages/extension/dist/` unpacked at `chrome://extensions`. With
`npm run dev` running, open any Pump.fun coin page, click the BIDit icon → Join +
Deposit, then the panel's "Start a demo auction here" (dev) — and bid, watch the
countdown, get outbid, win. All server-authoritative, inside the real Pump page.

## Escrow & settlement (Chunk 5)

A won auction becomes an order that walks a delivery-gated escrow flow
(Whatnot's model), all on simulated funds.

```
PENDING_SETTLEMENT → LOCKED → SHIPPED → DELIVERED → DISPUTE_WINDOW → RELEASED
                       │                                  │
                    CANCELED (no-ship timeout)         DISPUTED → REFUNDED | RELEASED
                       ↓
                    REFUNDED
```

- **The wall:** everything money-in/out-of-escrow goes through one
  `EscrowProvider` (`src/escrow.ts`). `DevWalletEscrow` is fully simulated —
  ledger entries only, **no chain, no keys, no real funds** (the escrow wallet
  address is recorded as a reference). `ProgramEscrow` drops in later behind the
  same interface without touching order logic.
- **On close:** the winner's `ACTIVE` hold is *captured* into an `ESCROW` ledger
  account (buyer → escrow, **no fee taken**).
- **`release`** splits escrow → 95% seller + 5% into the buyback-pending pool.
  **`refund`** returns 100% to the buyer — the fee is only ever taken on release,
  so refunds are whole.
- **Timers** (`processOrderTimers`): the dispute window auto-releases after 3
  days; a `LOCKED` order with no tracking auto-refunds after 7 days. Driven by
  the same injectable server clock.

Every movement is double-entry, so the ledger still sums to zero through the
whole flow. Drive it in dev via `/dev/order/{ship,deliver,release,dispute,resolve}`.

## Auth & the seller flow (Chunk 6)

Real accounts, still simulated money.

- **Auth** (`src/auth.ts`): stateless HMAC **session tokens** (used by the
  WebSocket and `Authorization: Bearer`), plus **wallet-signature login** — the
  Pump-native path: the client signs a challenge, the server verifies the ed25519
  signature (`tweetnacl`/`bs58`), no chain calls. A dev login covers demos
  without a wallet. The `dev.<userId>` stub is gone.
- **Authz**: only **verified sellers** create listings / run auctions; admin-only
  for verify / audit / dispute resolution.
- **Seller dashboard** (`/seller`): sign in, get verified, link your Pump coin,
  pre-load a queue of cards, then fire auctions one at a time and watch the bids
  live — the Whatnot-style live control surface.
- **Admin** (`/admin`): verify sellers, resolve disputes (release/refund), and a
  full **ledger audit** showing every account balance + the conservation total.

```bash
npm run dev   # then: /seller (seller dashboard) · /admin (admin) · / (buyer page)
```

## Real USDC rails (Chunk 7)

Real money, behind a `ChainClient` interface (`src/chain/`) — the same
mock-first pattern as everywhere else.

- **`MockChain`** (in-memory, deterministic) powers the tests; **`SolanaChain`**
  (real devnet SPL-USDC via `@solana/web3.js`) is the production drop-in, loaded
  only when `SOLANA_RPC` is set. Keypairs come from gitignored env; it refuses
  mainnet unless explicitly opted in.
- **Custodial v1**: backend-controlled `treasury` / `escrow` / `buyback` wallets
  hold pooled USDC; the ledger stays the source of truth (the non-custodial
  on-chain PDA program is the later upgrade).
- **Deposit** — per-user address; a `DepositWatcher` credits the ledger
  (idempotent on the tx signature). **Withdraw** — ledger debit (respecting
  holds) then treasury → the user's address, reversing on failure.
- **`ProgramEscrow`** does the Chunk-5 ledger moves *and* the real transfers:
  lock `treasury→escrow`, release `escrow→treasury` (95%) + `escrow→buyback`
  (5%), refund `escrow→treasury` (100%).
- **Buyback worker** spends the 5% pool on $BID behind a `Swapper` interface
  (the real Jupiter/Raydium swap is a mainnet drop-in), recording each buyback.

The whole flow — deposit → bid → win → escrow lock → ship → deliver → release →
seller paid + buyback funded — is a passing test (`test/chain-rails.test.ts`) on
the simulated chain; the live devnet run is in [docs/DEVNET.md](docs/DEVNET.md).

## What's next

The on-chain **PDA escrow program** (non-custodial), the real **Jupiter buyback
swap** on mainnet, and **shipping & tracking** (real labels / carrier webhooks
driving `SHIPPED → DELIVERED`). A turnkey `scripts/devnet-e2e.ts` is a quick add
whenever you want to script the full devnet pass.
