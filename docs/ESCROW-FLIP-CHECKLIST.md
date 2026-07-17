# Escrow flip — pre-launch checklist

The exact, ordered steps to switch `BIDIT_PAYOUT_MODE=direct → escrow` safely for
real beta use. Do them in order; don't flip until every box is checked.

## 0. Ship the code
- [ ] `git push` — the escrow build (steps 1–8), the withdrawal durable-settlement
      fix, and this pre-flip work must be on the branch Render deploys.
- [ ] Render deploys the new backend. It's still `BIDIT_PAYOUT_MODE=direct`, so
      escrow stays **dormant** — nothing changes for live users yet. Good.

## 1. Wallets (real money)
- [ ] `TREASURY_SECRET`, `ESCROW_SECRET`, `BUYBACK_SECRET`, `FEE_SECRET` are all set
      on Render to **distinct** mainnet keypairs. (A missing secret silently falls
      back to treasury — the startup guard now refuses to boot escrow mode if any
      of escrow/buyback/fee collapses onto treasury, so this is enforced, but
      verify anyway.)
- [ ] Each of **treasury, escrow, buyback, fee** holds a little **SOL** for gas —
      every wallet pays gas for its own outgoing legs (lock/release/refund), not
      just treasury.
- [ ] `SOLANA_RPC` is a paid endpoint (Helius/QuickNode) — the public RPC
      rate-limits (429s) the settler's confirmation polling.
- [ ] `SHIPPO_API_KEY` set (delivery → auto-release). Without it, mark delivered
      via the admin test controls instead.

## 2. Verify the plumbing (still in direct mode)
- [ ] `npm -w @bidit/backend run devnet:e2e` completes cleanly end to end
      (deposit → win → lock → release 95/4/1 → withdraw), with distinct
      escrow/buyback/fee wallets on devnet.
- [ ] In `/admin` → Orders, click **Reconcile wallets** (or run
      `audit:wallets` against prod): every wallet's on-chain USDC equals its ledger
      account (treasury ↔ Σ user balances, escrow ↔ ESCROW, buyback ↔ PLATFORM,
      fee ↔ FEE), with **0 pending legs**. This is the real green light.

## 3. Flip
- [ ] Set `BIDIT_PAYOUT_MODE=escrow` on Render and redeploy.
- [ ] Watch the boot logs: `payout=escrow`, `[chain] cluster=mainnet-beta`,
      `[chain-settle] …`, and the wallet guard passing (no "Refusing to run escrow
      mode" error).

## 4. Smoke test on mainnet (small, do it yourself first)
- [ ] Win a $1–2 auction with a second account → confirm the order is **LOCKED**
      and the `treasury → escrow` leg settles (Reconcile wallets shows escrow up).
- [ ] Pay shipping → confirm size → make the label in `/admin` → mark shipped →
      mark delivered → after the 2-day window (or "Release payment now"), confirm
      the seller balance rises 95%, and buyback/fee wallets get 4%/1%.
- [ ] Withdraw the seller balance → confirms on-chain.
- [ ] Reconcile wallets again → still balanced.

## What the automated timers do now (so nothing moves money wrongly)
- **Delivered + 2 days, no dispute →** auto-release 95/4/1.
- **Buyer paid shipping, seller didn't ship in 7 business days →** refund the item
  to the buyer (shipping is kept).
- **Buyer never paid shipping, ship-later hold (14d) expires →** forfeit the win to
  the seller (they keep the card and are paid).
- **Everything else (disputes, edge cases) →** you resolve in `/admin`.
