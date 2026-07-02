# Deploying BIDit for the live test (Vercel + Render)

Two pieces, two hosts:
- **Web app → Vercel** (static Vite/React SPA). Vercel is ideal for this.
- **Backend + Postgres → Render** (always-on Node server: WebSockets + background
  auction/deposit loops). Vercel *cannot* host this — it's serverless and can't
  keep sockets or pollers alive. Railway or Fly.io work too.

> Do the real-money safety reading in [MAINNET-TEST.md](./MAINNET-TEST.md) first —
> custody, no buyer protection, and the mandatory $1 smoke test. This doc is just
> the hosting mechanics.

## 1. Backend on Render (do this first — the web needs its URL)
1. Push this repo to GitHub.
2. In Render: **New → Blueprint**, pick the repo. It reads [`render.yaml`](../render.yaml) and proposes `bidit-backend` + `bidit-db`.
3. Before the first deploy, set the **secret** env vars (dashboard → the service → Environment):
   - `SOLANA_RPC` — your mainnet RPC (Helius/QuickNode).
   - `TREASURY_SECRET` — your treasury keypair (base58 or JSON byte array). Fund this wallet with **~0.05–0.1 SOL** for gas.
   - `BIDIT_WALLET_SEED` — a long, unique, secret string. **Back it up** (it controls every deposit address).
   - `AUTH_SECRET` — a long random string.
   The non-secret ones (`BIDIT_PAYOUT_MODE=direct`, `SOLANA_CLUSTER=mainnet-beta`, `BIDIT_ALLOW_MAINNET=yes`, `USDC_MINT`, `DATABASE_URL`) are already in the blueprint.
4. Deploy. The build runs `prisma db push` against the managed DB, then starts the server. Logs should show:
   `[chain] cluster=mainnet-beta · payout=DIRECT (no escrow, no fee) · dev-endpoints=off`
   and the treasury address. Note the service URL, e.g. `https://bidit-backend.onrender.com`.

**Security note:** on a real chain the dev-only endpoints (password-less `/dev/login`, balance-minting `/dev/deposit`, seeders) are **automatically disabled**. Leave `BIDIT_ENABLE_DEV_ENDPOINTS` unset.

## 2. Web app on Vercel
This repo is a monorepo (backend + web + extension all live in one repo), but
`packages/web` is fully self-contained — it doesn't depend on any other package.
So the simplest setup is to point Vercel's **Root Directory** straight at it.

1. In Vercel: **Add New → Project**, import the same repo.
2. On the import screen (or after, in **Settings → General**), set:
   - **Root Directory** → `packages/web`
   - Framework Preset should auto-detect as **Vite** — leave Build/Output/Install commands on their defaults (don't override them; the framework defaults are correct once Root Directory is set).
3. Add one **Environment Variable**:
   - `VITE_API = https://bidit-backend.onrender.com` (your backend URL from step 1).
   *(Vite inlines this at build time, so it must be set before you deploy. Redeploy if you change it.)*
4. Deploy. Your test URL is the Vercel domain (e.g. `https://bidit.vercel.app`) — that's what you send friends.

`packages/web/vercel.json` (committed in the repo) just adds the SPA rewrite rule so client-side routing (react-router) works on refresh/deep-links — everything else uses Vercel's Vite defaults.

**If you already created a project and it failed** with `Error: No Output Directory named "dist" found`: that's this exact issue — Root Directory wasn't pointed at `packages/web`. Go to **Settings → General → Root Directory**, set it to `packages/web`, save, then **Deployments → ⋯ → Redeploy**.

## 3. Verify, then invite
- Open the Vercel URL, sign up, go to **Deposit** — you should see a red **Mainnet** tag and your real deposit address (the dev "simulate" button is gone).
- Run the **$1 smoke test** from [MAINNET-TEST.md](./MAINNET-TEST.md) (deposit → win → withdraw) **before** sharing the link.
- Keep the Render service on an always-on plan and the treasury topped up with a little SOL.

## Notes / gotchas
- **Cost:** Render `starter` web + `basic-256mb` Postgres are a few dollars/month total; Vercel hobby is free. Don't use Render's free web plan — it sleeps and would drop sockets/deposit polling.
- **Custom domain:** add it in Vercel for the web; if you do, point `VITE_API` at the backend's domain (Render custom domain optional).
- **CORS** is already `*` on the backend, so the Vercel origin can call it.
- **Schema changes later:** re-deploying the backend re-runs `prisma db push` (it won't drop data unless the schema forces it).
