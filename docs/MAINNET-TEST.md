# BIDit — real-money friends test (mainnet, no escrow)

This is the runbook for a **live test with real USDC on Solana mainnet**, in the
simplified payout mode you asked for: **no escrow, no 5% fee** — a sale pays the
seller 100% instantly, and everyone withdraws afterward.

> ⚠️ **Read this first.** This is real money and it is **custodial**: every
> deposit lands at an address your server controls, and an internal ledger tracks
> who owns what. **You are holding your friends' funds.** There is **no buyer
> protection** — once an auction closes, payment is final. The on-chain transfer
> code has been made correct by construction and unit-tested, but has **never run
> against a real chain**, so the **first thing you do is a $1 smoke test** (below)
> before inviting anyone. Use amounts everyone can afford to lose.

## How the money flows
- Each user gets a **deposit address** derived from your master seed (`BIDIT_WALLET_SEED`). No per-user private keys are stored.
- A friend sends **USDC** to their deposit address → the watcher detects it, **sweeps it into your treasury wallet**, and credits their in-app balance.
- Bidding **reserves** balance (doesn't spend it). Winning **spends** it → the seller's in-app balance goes up 100%.
- **Withdraw** sends real USDC from the **treasury** to any external Solana address.

So: treasury holds the pooled USDC; the ledger is the source of truth; withdrawals draw from the treasury. As long as the ledger balances sum to the treasury balance, everyone can cash out.

## Prerequisites
1. **A managed Postgres** (Supabase/Neon/RDS). The dev server's embedded Postgres is not for production — you'll set `DATABASE_URL`.
2. **A mainnet RPC** with decent limits — Helius or QuickNode (the public RPC will rate-limit you).
3. **A treasury hot wallet** (a fresh Solana keypair you control). Fund it with **~0.05–0.1 SOL** for transaction fees (sweeps + withdrawals pay gas from here).
4. Mainnet **USDC mint**: `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`.

## Environment (backend)
Set these where the backend runs. **You set the secrets yourself — never share the treasury key or wallet seed with anyone, including me.**

```bash
# database (managed Postgres — NOT the embedded dev one)
DATABASE_URL="postgresql://…"

# chain
SOLANA_RPC="https://…your-mainnet-rpc…"
SOLANA_CLUSTER="mainnet-beta"
BIDIT_ALLOW_MAINNET="yes"
USDC_MINT="EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
TREASURY_SECRET="<base58 secret key OR JSON byte array of your treasury keypair>"

# custody — controls ALL user deposit addresses. Strong, unique, ≥24 chars.
# BACK THIS UP: lose it and un-swept deposits are unrecoverable.
BIDIT_WALLET_SEED="<long random string you generate and keep secret>"

# payout mode: skip escrow + fee, pay seller 100% on sale
BIDIT_PAYOUT_MODE="direct"

# sessions — set a strong random value (not the dev default)
AUTH_SECRET="<long random string>"

PORT="8787"
```

Notes:
- `ESCROW_SECRET` / `BUYBACK_SECRET` are **not needed** in direct mode — they fall back to the treasury wallet and are never used.
- The backend **refuses to start on mainnet** if `BIDIT_ALLOW_MAINNET` isn't `yes` or if `BIDIT_WALLET_SEED` is weak/default. That's intentional.

## Run it
Point the backend at your managed Postgres and run the server **directly** (not through the embedded-DB wrapper):

```bash
# one-time: push the schema to your managed DB
npx prisma db push --schema packages/backend/prisma/schema.prisma

# start (loads .env; do NOT use `npm run dev`, which starts the embedded Postgres)
node --import tsx packages/backend/scripts/dev-server.ts
```

On boot you should see:
```
[chain] cluster=mainnet-beta · payout=DIRECT (no escrow, no fee)
[chain] ⚠️  MAINNET — REAL USDC WILL MOVE. treasury: <address>
```
Deploy the web app (`packages/web`) with `VITE_API` pointing at the backend's public HTTPS URL.

## The $1 smoke test (do this alone, before friends)
1. Sign up as yourself. Open **Deposit** → copy your address (it now shows a red **Mainnet** tag; the "simulate deposit" button is hidden).
2. Send **$1 USDC** to it from Phantom. Within a few seconds the balance should show **$1** (watch the server logs; the sweep tx appears on the treasury's explorer page).
3. As a second account (a friend or a second signup), fund it, run a tiny auction, and **win it** → confirm the seller balance goes up by the exact amount, buyer's down.
4. **Withdraw** the seller balance to an external wallet → confirm the USDC arrives on-chain.
5. Only once all four work end-to-end, invite the group.

## During the test
- Keep an eye on the **treasury SOL balance** — if it runs dry, sweeps/withdrawals fail (top it up).
- The treasury's USDC balance should always be **≥ the sum of everyone's in-app balances**. If you want to reconcile, the `/admin/audit` endpoint reports per-account balances.
- If a deposit doesn't show up: the watcher polls every 5s and re-checks on each keep-alive; make sure the depositor sent **USDC** (not SOL or another token) to the **exact** address shown.

## What this test does NOT include (by design, for now)
- **No 5% $BID buyback** and **no escrow / buyer protection** — you turned these off.
- Not a substitute for a security audit, KMS key custody, or KYC/AML — those are required before this is anything more than a friends test. Don't scale this as-is.
