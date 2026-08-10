# SOL deposits + treasury auto-swap

Users can deposit **native SOL** to the same address they already use for USDC.
The SOL is swept into treasury and the depositor is credited **USDC** at the live
oracle price minus a spread. Optionally, a worker converts that treasury SOL back
to USDC (Jupiter) so treasury USDC keeps backing user balances and the spread is
realized as profit. **Withdrawals are always USDC** and never touch SOL.

## Flow

1. User sends SOL to their deposit address (shown on the Deposit page, SOL tab).
2. `DepositWatcher.pollSolDeposits` sweeps it to treasury and writes a
   `DepositReceipt` (`asset: "SOL"`, raw `lamports`, uncredited).
3. On the next credit pass the SOL/USD oracle (`prices.ts`, Pyth cross-checked
   with Coinbase) prices it; the user is credited `lamports × price × (1 − spread)`
   and the receipt records the price, spread, and source.
   - **If the oracle is down the receipt stays unpriced and retries** — a SOL
     deposit can be delayed, never lost, never mispriced.
4. (Optional) `TreasurySwapWorker` swaps treasury SOL above a reserve into USDC
   via Jupiter and records a `TreasurySwap` row.

Idempotency is the sweep signature (`DepositReceipt.txSig` unique +
`chain-deposit:<sig>` ledger key), identical to the USDC path.

## Env vars (set in the Render dashboard — do NOT add to render.yaml)

| Var | Default | Meaning |
|---|---|---|
| `BIDIT_SOL_DEPOSITS` | on | Set `no` to disable SOL deposits entirely. |
| `BIDIT_SOL_SPREAD_BPS` | `150` | Conversion spread in basis points (1.5%). Clamped 0–1000. |
| `BIDIT_SOL_MIN_LAMPORTS` | `1000000` | Dust floor (0.001 SOL); below this SOL is left to accumulate. |
| `BIDIT_AUTO_SWAP` | off | Set `yes` to auto-convert treasury SOL→USDC. **Real trading.** |
| `BIDIT_SWAP_SLIPPAGE_BPS` | `100` | Max Jupiter slippage (1%). |
| `BIDIT_TREASURY_SOL_RESERVE_LAMPORTS` | `300000000` | SOL kept for fees (0.3 SOL). |
| `BIDIT_MIN_SWAP_LAMPORTS` | `50000000` | Don't swap less than this (0.05 SOL). |

The audit (`reconcileWallets`) values unswapped treasury SOL at spot, so treasury
is "reconciled" as long as USDC + SOL value ≥ user liabilities (the spread makes
it run slightly rich, which is safe).

## Mainnet validation (Kareem — I cannot run mainnet txs)

The SOL sweep, the Jupiter swap, and confirmation only run on the real chain, so
validate on mainnet with a small amount before relying on auto-swap:

1. Send ~0.05 SOL from a wallet to your BIDit deposit address. Confirm it's
   credited as USDC at ~spot−1.5% within a minute, and the "Deposited N SOL → $X"
   notification fires.
2. Check `/admin` treasury: the SOL landed, USDC liability matches.
3. Enable `BIDIT_AUTO_SWAP=yes`. Within a minute the excess SOL (above the 0.3
   reserve) should swap to USDC; verify a `TreasurySwap` row and that treasury
   USDC rose by ~the market value.
4. Watch `[auto-swap]` logs. A failed swap logs and retries, leaving SOL safe.
5. Confirm a normal USDC **withdrawal** still works and is unaffected.

Notes / known spike items:
- The swap records USDC out via a treasury balance delta; a concurrent USDC move
  could skew the *recorded* amount (not funds). Fine for the amounts involved.
- `confirmTransaction` uses a freshly-fetched blockhash (longer timeout window);
  functionally safe. Revisit if confirmations lag.
