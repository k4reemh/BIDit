# BIDit on Solana devnet — runbook

Chunk 7 ships real USDC rails behind a `ChainClient` interface. The whole flow is
verified in CI against a **simulated chain** (`MockChain`); this runbook is how you
run the **real** thing on **devnet** (test money, zero real value).

> Safety: keypairs live only in your local env files (gitignored). Never paste a
> secret key into a chat or commit it. The Solana client refuses `mainnet-beta`
> unless you set `BIDIT_ALLOW_MAINNET=yes`. Keep it on devnet.

## 0. Prerequisites

```bash
sh -c "$(curl -sSfL https://release.anza.xyz/stable/install)"   # Solana CLI
solana config set --url https://api.devnet.solana.com
```

## 1. Wallets (treasury, escrow, buyback)

Generate three devnet keypairs (these are the backend-controlled wallets):

```bash
mkdir -p ~/.bidit-keys
solana-keygen new --no-bip39-passphrase -o ~/.bidit-keys/treasury.json
solana-keygen new --no-bip39-passphrase -o ~/.bidit-keys/escrow.json     # your 3BbG… wallet's devnet key, if you have it
solana-keygen new --no-bip39-passphrase -o ~/.bidit-keys/buyback.json
# Fund them with devnet SOL for tx fees:
for w in treasury escrow buyback; do solana airdrop 2 $(solana-keygen pubkey ~/.bidit-keys/$w.json); done
```

## 2. A devnet USDC test mint

Devnet has no canonical USDC, so create a 6-decimal test mint and fund treasury.
Easiest: make treasury the CLI's default keypair so create/mint default to it.

```bash
solana config set --keypair ~/.bidit-keys/treasury.json
spl-token create-token --decimals 6     # prints <USDC_MINT>; mint authority = treasury
spl-token create-account <USDC_MINT>    # treasury's USDC token account
spl-token mint <USDC_MINT> 100000       # 100,000 test USDC -> treasury
```

(Devnet airdrops are rate-limited; if `solana airdrop` fails, retry or use
https://faucet.solana.com.)

## 3. Env

Create `packages/backend/.env.devnet` (gitignored):

```bash
SOLANA_RPC=https://api.devnet.solana.com
SOLANA_CLUSTER=devnet
USDC_MINT=<USDC_MINT from step 2>
TREASURY_SECRET=<base58 or JSON array of ~/.bidit-keys/treasury.json>
ESCROW_SECRET=<…escrow.json>
BUYBACK_SECRET=<…buyback.json>
DEPOSIT_SEED=<any random string — derives per-user deposit addresses>
```

The `*_SECRET` values are the file contents (`cat ~/.bidit-keys/treasury.json` gives
a JSON byte array — that works directly) or a base58 secret key. You don't need a
`DATABASE_URL` here — the e2e command boots a throwaway local Postgres for the
ledger and injects it automatically.

## 4. How the money flows (custodial v1)

- **Deposit** — each user gets a derived address (`ensureDepositAddress`). Send
  test USDC there; the `DepositWatcher` sweeps it to treasury and credits the
  ledger (`DEPOSIT`), idempotent on the tx signature.
- **Bid / hold / charge** — unchanged; they now back real settled USDC.
- **Win → escrow** — `ProgramEscrow.lock` moves treasury → escrow on-chain +
  the ledger `ESCROW_LOCK` (no fee yet).
- **Release** — escrow → treasury (95%, seller's custodial balance) + escrow →
  buyback (5%). **Refund** — escrow → treasury (100%). Fee only on release.
- **Withdraw** — ledger `WITHDRAWAL` debit (checks available = settled − holds),
  then treasury → the user's address.
- **Buyback** — `BuybackWorker` spends the 5% pool on $BID. On devnet there's no
  $BID/LP, so the swap is reserved (a real Jupiter/Raydium swap drops into the
  `Swapper` interface on mainnet).

## 5. Verify the wiring

The simulated-chain version of the entire flow is a passing test:

```bash
npm test    # see test/chain-rails.test.ts — deposit → … → release → buyback
```

To exercise **real devnet** end-to-end with one command:

```bash
npm run devnet:e2e
```

It loads `.env.devnet`, then runs deposit → bid → win → escrow lock → ship →
deliver → release (95% seller / 5% buyback) → buyback → seller withdrawal — the
escrow/withdrawal transfers are real, signed by your keypairs, and it prints a
Solana Explorer link for every on-chain tx so you can watch the USDC move.

Notes:
- The script funds the "deposit" from treasury → the buyer's deposit address (to
  simulate a user sending USDC); the watcher then sweeps it back and credits the
  ledger. So treasury just needs the ~$100 test USDC from step 2.
- The buyback's 5% is **reserved** in the buyback wallet on devnet (there's no
  $BID token / LP there); the real Jupiter/Raydium swap is the mainnet drop-in.
- Public devnet RPC is rate-limited; if you see 429s, use a free Helius devnet RPC
  in `SOLANA_RPC`.
