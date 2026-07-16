# Dependency audit — triage & accepted risk

`npm audit` is run informationally in CI (`.github/workflows/ci.yml`) and does **not**
block the build, because every current advisory is a transitive dependency of the
Solana RPC client with no safe automatic fix. This document records the deliberate
triage so the warnings aren't just ignored.

_Last reviewed: 2026-07-16 · `npm audit`: 10 (6 moderate, 4 high)._

## Findings (all transitive, one root cause)

```
uuid  (vulnerable version)
└─ jayson                 (JSON-RPC client — uses uuid for request ids)
   └─ @solana/web3.js     (<= 1.98.4)
      ├─ @solana/spl-token-group
      └─ @solana/spl-token-metadata
```

Every advisory chains up from **`uuid`**, pulled in by **`jayson`**, pulled in by
**`@solana/web3.js`**, which the SPL token packages depend on. We depend on
`@solana/web3.js` + `@solana/spl-token` directly (deposits, sweeps, withdrawals);
`jayson`/`uuid` are pulled in underneath, not used by us directly.

## Why we are NOT auto-fixing

`npm audit fix --force` proposes **`@solana/web3.js@0.0.3`** — a ~unmaintained
pre-1.0 version. That is a catastrophic breaking downgrade that would remove the
APIs the whole chain layer is built on (`Connection`, `Keypair`, SPL transfers).
Applying it would break every deposit, sweep and withdrawal. Rejected.

## Exploitability assessment (why it's acceptable for beta)

- The flagged `uuid` weakness affects how request identifiers are generated inside
  the RPC client. Those ids are internal JSON-RPC correlation ids — not session
  tokens, not deposit addresses, not anything security-bearing. Our own secrets
  (sessions, deposit-address derivation) use `node:crypto`, not `uuid`.
- The advisories are in the **outbound RPC client**, which talks to our own trusted
  Solana RPC endpoint — not a surface fed by untrusted user input.
- No advisory here is a remote-code-execution or an auth-bypass in a path we expose.

Net: low practical risk for the current beta.

## Proper resolution (scheduled, not a beta blocker)

Upgrade the Solana stack deliberately, with regression testing of the chain rails
(`chain-rails.test.ts`, `deposit.reconcile.test.ts`, `withdrawal.cap.test.ts`):

- Move to a patched `@solana/web3.js` (a 1.x that drops the vulnerable `jayson`/`uuid`,
  or the `@solana/web3.js` **2.x** line — note 2.x is an API rewrite and needs code
  changes in `src/chain/solana.ts`), plus matching `@solana/spl-token`.
- Re-run `npm audit` and update this file.

Do this as a focused maintenance PR — never via `--force`.
