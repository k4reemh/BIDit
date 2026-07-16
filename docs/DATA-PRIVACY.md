# Data privacy — PII encryption, erasure & retention

## Personal data we store

- **User:** handle, optional email, optional display name / avatar / bio, and an
  optional saved **shipping address** (the sensitive one).
- **Shipment:** an address snapshot (`shipTo`, and `privateLeg2` for private mode)
  captured when a buyer chooses to ship a won item.
- Wallet address (for wallet login) and the append-only financial ledger (no PII
  beyond the account link).

## Encryption at rest (application layer)

Shipping addresses are encrypted with **AES-256-GCM** before they touch the
database (`src/pii.ts`), on top of the managed database's own disk-level at-rest
encryption. A leaked DB dump is therefore useless without the key.

- Key: **`BIDIT_PII_KEY`** (≥16 chars; `openssl rand -base64 32`). Set it in the
  Render dashboard. Production warns at startup if it's missing.
- **Opt-in & migration-free:** with no key set, values are stored as-is
  (passthrough). Turning the key on encrypts *new* writes; pre-existing plaintext
  rows keep working (they're re-encrypted next time they're written).
- **Keep the key stable.** Once data is encrypted, losing/rotating the key makes
  those rows unreadable — decryption fails closed (returns null), never garbage.
- Covered fields: `User.shippingAddress`, `Shipment.shipTo`, `Shipment.privateLeg2`.

## Right to erasure

`POST /me/erase` (authenticated; UI: Profile → "Delete my account & data")
permanently wipes the caller's personal data — email, name, avatar, bio, saved
shipping address, and login credentials (password + wallet) — anonymises the
handle to `deleted_<random>`, and revokes all sessions. The row itself is kept so
the double-entry ledger and order history stay referentially intact (financial
records are not deleted). Address snapshots on in-flight shipments are left so the
seller can still fulfil the order, and age out under retention.

## Retention (posture)

- Financial/ledger records are retained for integrity and audit.
- Shipment address snapshots exist only for active fulfilment; purge delivered/old
  shipments' address snapshots on a retention schedule (future job).
- A user who erases their data can no longer sign in; the anonymised shell remains
  only to anchor historical financial rows.
