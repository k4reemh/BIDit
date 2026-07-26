# Seller coin auto-create — how it works + mainnet validation runbook

Every new seller gets a pump.fun coin made for them during onboarding:
**"<handle>'s BIDit Livestream"**, branded BIDit art, created **off-chain and
completely free** — exactly what pump.fun's own /create page does for a 0-SOL
launch. The coin is auto-linked as their saved coin (`SellerProfile.pumpCoinAddress`),
so the watch page, live grid, and stream proxy work with zero extra setup.

**The coin is created under the seller's own pump.fun account.** That is
load-bearing: pump.fun only shows the **Start livestream** button to the coin
creator. It also means the seller keeps pump.fun's creator fees, and BIDit never
touches private keys.

The seller signs **one plain-text message** — pump.fun's sign-in line — not a
transaction. So there is no fee, nothing can be spent, and none of the wallet's
"this dApp may be malicious" transaction warnings appear. That signature grants a
pump.fun session for their wallet, so it is treated as a credential: verified
locally, spent on exactly one create, held in memory, **never stored or logged**.

There is deliberately **no automatic fallback to the on-chain path**. If pump.fun
refuses, the seller is told plainly and pointed at pump.fun/create + paste-in-
Settings — we never quietly swap in a route that charges a fee or trips a wallet
warning.

## Architecture

```
browser (Phantom)                 backend                        pump.fun
────────────────                  ───────                        ────────
                                  POST /seller/coin-create/prepare
     ◄── "Sign in to pump.fun:     store PREPARED attempt
          <timestamp>" ──────────    (timestamp only — no tx, no mint yet)
sign message in Phantom
  (no fee, no tx warning)
     ── signature (base64) ──────►  POST /seller/coin-create/submit
                                    verify ed25519 locally FIRST
                                    claim PREPARED→SUBMITTED
                                    auth/login ─────────────────►  session cookie
                                    users/register ─────────────►
                                    ipfs-presign ×2 ────────────►  60s Pinata URLs
                                    upload art + metadata ──────►  {data:{cid}}
                                    coins/create-v2 ────────────►  201 {mint}
                                    link coin (CONFIRMED)
```

The wire contract above was verified against real captures, not guessed: the
sign-in text is the one whose signature validates against a live pump.fun login,
and the presign/upload shapes came from probing the (unauthenticated) endpoints.

- Lifecycle: `PumpCoinCreateAttempt` — `PREPARED → SUBMITTED → CONFIRMED | FAILED | SUPERSEDED`.
  An off-chain create settles inside its own request; a SUBMITTED row that outlives
  it (process died mid-call) is marked FAILED by the next status poll, with copy
  telling the seller to check pump.fun before retrying, in case it did land.
- Sign-in signatures expire after 5 minutes (`LOGIN_TTL_MS`); a stale one returns
  `TX_EXPIRED` and the client silently prepares a fresh one, once.
- Provider seam (`src/chain/pump-provider.ts`) is a union of two shapes so they
  can't be confused: `kind: 'offchain'` (default on mainnet) and `kind: 'tx'` (the
  PumpPortal escape hatch). Mocks of both run the whole flow in dev/preview/vitest
  with no network and no Phantom — `test/pump-offchain.flow.test.ts` covers the
  shipping path, signing with a throwaway keypair.
- Guards: per-seller advisory lock, one submittable attempt at a time, atomic
  PREPARED→SUBMITTED claim (double-submit broadcasts once), `mint` and
  `pumpCoinAddress` DB-unique, first-claim-wins preserved end to end, and a
  confirmed create never overwrites a coin linked by other means mid-flight.

## Env (Render)

| var | required | notes |
|---|---|---|
| `SOLANA_RPC` | already set | unused by the off-chain path; needed by the pumpportal escape hatch |
| `BIDIT_WEB_ORIGIN` | recommended | e.g. `https://<your-site>.vercel.app` — the coin's metadata links here; falls back to the first `BIDIT_ALLOWED_ORIGINS` entry |
| `BIDIT_PUMP_PROVIDER` | optional | `offchain` / `pumpportal` / `mock` / `mock-offchain` (default: `offchain` on mainnet, mock elsewhere) |
| `BIDIT_PUMP_PRIORITY_FEE_SOL` | optional | default `0.0001`; pumpportal only |

No new secrets.

## ⚠️ One-time schema note (already shipped)

The unique index on `SellerProfile.pumpCoinAddress` went out with the first
release of this feature. The check below is kept because it is what to run if a
`prisma db push` ever fails on it again. If the
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

## Mainnet validation (~5 min, $0)

The off-chain path spends nothing, so this is a functional check, not a cost one.
Use a **throwaway** Phantom wallet — it will own a real pump.fun coin afterwards.

1. Run the backend locally against mainnet:
   `SOLANA_CLUSTER=mainnet-beta BIDIT_ALLOW_MAINNET=yes` (+ your strong
   `AUTH_SECRET`/`BIDIT_WALLET_SEED` per the boot guard). No `BIDIT_PUMP_PROVIDER`
   — mainnet already defaults to `offchain`. Web via `npm -w @bidit/web run dev`.
2. Sign in → become a seller → onboarding coin step → **Create my livestream coin**.
   Phantom should show a **message** signature reading
   `Sign in to pump.fun: <numbers>` — no fee line, no transaction preview, and no
   "malicious dApp" warning. If you see a transaction, you are not on the
   off-chain provider.
3. **The decision criterion:** click **Go to your coin page** logged into pump.fun
   as that wallet → the **Start livestream** button must appear. Start a test stream.
4. BIDit checks: `/live/<mint>` plays it; the coin shows on the live grid; Settings
   shows it linked with the address filled in; the coin's pump.fun page shows the
   BIDit name/art/description.
5. Failure drills: reject the Phantom popup (friendly error, retry works); wait
   >5 min before approving (auto re-prepare, one extra popup); switch Phantom
   account then sign (WALLET_MISMATCH, attempt survives, nothing created).
6. Repeat one create against the **Render** deploy — that is the real test of
   pump.fun's Cloudflare from datacenter egress (the livestream proxy already
   passes with the same headers, so expect OK, but confirm it).
7. Grep server logs: only pubkeys may appear. No cookie values, no signatures.
   `[pump-create]` warnings identify which pump.fun call failed.

### If pump.fun changes and creates start failing

Sellers see a plain error plus the manual route (pump.fun/create → paste in
Settings), so nothing is stuck. To diagnose, `[pump-create]` logs name the failing
step. The likely breakages are the sign-in text (re-verify a fresh capture's
signature against `pumpLoginMessage`), the presign response field (`data`), the
upload response field (`data.cid`), or `create-v2`'s body/response shape. As a
stopgap `BIDIT_PUMP_PROVIDER=pumpportal` restores the on-chain path — but that
reintroduces network fees and the wallet warning, so treat it as a deliberate,
temporary choice, not a silent fallback.

## Notes

- Existing sellers keep their coins; the paste-a-coin path remains everywhere.
- A FAILED/abandoned attempt is inert: on the off-chain path nothing exists until
  pump.fun answers 201, and the attempt row holds no mint until then.
- Admin coin moves stay support-only (`POST /admin/seller-coin` — first-claim-wins
  is never bypassable self-serve).
