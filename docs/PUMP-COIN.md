# Seller coin auto-create — how it works + mainnet validation runbook

Every new seller gets a pump.fun coin made for them during onboarding:
**"<handle>'s BIDit Livestream"**, branded BIDit art, **$0 initial buy** (pump.fun
moved the deploy cost to the coin's *first buyer* in June 2026, so creating costs
the seller only dust network fees). The coin is auto-linked as their saved coin
(`SellerProfile.pumpCoinAddress`), so the watch page, live grid, and stream proxy
work with zero extra setup.

**The seller's own wallet signs the create and is the on-chain creator.** That is
load-bearing: pump.fun only shows the **Start livestream** button to the coin
creator's logged-in account. It also means the seller keeps pump.fun's creator
fees, and BIDit never touches private keys.

## Architecture

```
browser (Phantom)                 backend                        pump.fun / PumpPortal
────────────────                  ───────                        ─────────────────────
                                  POST /seller/coin-create/prepare
                                    mint keypair (ephemeral)
                                    metadata + art  ────────────►  pump.fun /api/ipfs
                                    unsigned create tx  ◄────────  pumpportal trade-local (amount 0)
                                    VET (fee payer, program
                                    allowlist, single pump ix)
                                    fresh blockhash, mint-sign
     ◄── messageB58 ──────────────  store PREPARED attempt
sign in Phantom
     ── signature ───────────────►  POST /seller/coin-create/submit
                                    merge + verify ALL sigs
                                    txSig fixed pre-broadcast
                                    broadcast on our RPC ───────►  Solana
                                    confirm → link coin (CONFIRMED)
```

- Lifecycle: `PumpCoinCreateAttempt` — `PREPARED → SUBMITTED → CONFIRMED | FAILED | SUPERSEDED`.
  Withdrawals stance: ambiguous sends are never failures; only the chain (error, or
  not-found past `lastValidBlockHeight`) declares death. A closed tab is recovered by
  the status endpoint's lazy reconcile on the next page view.
- Provider seam (`src/chain/pump-provider.ts`): `pumpportal` on mainnet, `mock`
  everywhere else (`BIDIT_PUMP_PROVIDER` overrides). The mock makes the entire flow
  run in dev/preview/vitest with no chain and no Phantom.
- Guards: per-seller advisory lock, one submittable attempt at a time, atomic
  PREPARED→SUBMITTED claim (double-submit broadcasts once), `mint` and
  `pumpCoinAddress` DB-unique, first-claim-wins preserved end to end, and a
  confirmed create never overwrites a coin linked by other means mid-flight.

## Env (Render)

| var | required | notes |
|---|---|---|
| `SOLANA_RPC` | already set | the provider builds/broadcasts on this RPC |
| `BIDIT_WEB_ORIGIN` | recommended | e.g. `https://<your-site>.vercel.app` — the coin's metadata links here; falls back to the first `BIDIT_ALLOWED_ORIGINS` entry |
| `BIDIT_PUMP_PROVIDER` | optional | `mock` / `pumpportal` override (default: pumpportal on mainnet only) |
| `BIDIT_PUMP_PRIORITY_FEE_SOL` | optional | default `0.0001` |

No new secrets.

## ⚠️ Before the first deploy of this feature

The schema adds a **unique index on `SellerProfile.pumpCoinAddress`**. If the
production DB has two sellers holding the same coin, `prisma db push` (the Render
build step) will FAIL. Check first (read-only):

```sql
SELECT "pumpCoinAddress", count(*)
FROM "SellerProfile"
WHERE "pumpCoinAddress" IS NOT NULL
GROUP BY 1 HAVING count(*) > 1;
```

Empty ⇒ deploy freely. Rows ⇒ decide the rightful owner, null the other:

```sql
-- keeps the most recently created profile (what resolveRoomByCoin resolves today)
UPDATE "SellerProfile" SET "pumpCoinAddress" = NULL
WHERE "pumpCoinAddress" = '<dupe>' AND id <> (
  SELECT id FROM "SellerProfile" WHERE "pumpCoinAddress" = '<dupe>'
  ORDER BY "createdAt" DESC LIMIT 1
);
```

(The dev DB had exactly this — a stale duplicate of a shared test coin — and the
same cleanup fixed it.)

## Mainnet validation spike (~15 min, < $2 of SOL)

Everything below is a one-time proof that the real-provider path works end to end.
Use a **throwaway** Phantom wallet.

1. **Dup check** above on prod DB (must be empty).
2. Create a throwaway Phantom wallet; fund ~0.01 SOL.
3. Run the backend locally against mainnet with the real provider:
   `SOLANA_RPC=<rpc> SOLANA_CLUSTER=mainnet-beta BIDIT_ALLOW_MAINNET=yes BIDIT_PUMP_PROVIDER=pumpportal` (+ your strong `AUTH_SECRET`/`BIDIT_WALLET_SEED`
   per the boot guard), web via `npm -w @bidit/web run dev`.
4. Sign in → become a seller → onboarding step 3 → **Create my livestream coin**:
   - Phantom pops with a create-shaped transaction (no transfers beyond fees/rent).
   - If the flow errors with "unexpected signature format": this Phantom build lacks
     the low-level API — flip `web/src/lib/phantom.ts` to the object-form fallback
     (`signedTxB64` lane; the backend already accepts it).
5. **Cost check:** wallet is down only dust (no dev buy). If PumpPortal rejected
   `amount: 0`, promote the direct-instruction provider before launch (provider
   seam is ready for it).
6. **The decision criterion:** log into pump.fun with the throwaway wallet, open
   the new coin page → the **Start livestream** button must appear. Start a quick
   test stream.
7. BIDit checks: `/live/<mint>` plays the stream; the coin shows on the live grid;
   Settings shows it linked; coin page name/art/description link back to the site.
8. Failure drills: reject the Phantom popup (friendly error, retry works); wait
   >2 min before approving (auto re-prepare, one extra popup); switch Phantom
   account then sign (WALLET_MISMATCH, attempt survives).
9. Repeat one **prepare** against the Render deploy (Cloudflare from datacenter
   egress — the livestream proxy already passes with the same headers, expect OK).
10. Grep server logs for anything secret-shaped: only pubkeys/signatures may
    appear. `[pump-create]` warnings identify provider-side failures.

## Notes

- Existing sellers keep their coins; the paste-a-coin path remains everywhere.
- A FAILED/abandoned attempt is inert: the mint never existed on-chain (the
  create tx never landed) and each new attempt uses a fresh mint keypair.
- Admin coin moves stay support-only (`POST /admin/seller-coin` — first-claim-wins
  is never bypassable self-serve).
