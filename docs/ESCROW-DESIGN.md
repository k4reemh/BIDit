# Escrow + fulfillment — finalized design

The source of truth for turning escrow on. Everything here is agreed; the build
and the durable-settlement hardening are executed against this doc.

Mode flip: `BIDIT_PAYOUT_MODE=direct` → `escrow`. Direct mode (instant 100% to
seller, no fee) stays the current live-test behavior until we cut over.

---

## 1. Wallets & ledger accounts

Four on-chain wallets (all already in env — **no separate shipping wallet**):

| Wallet | Env secret | Holds |
|---|---|---|
| treasury | `TREASURY_SECRET` | pooled deposits + everyone's withdrawable balance |
| escrow | `ESCROW_SECRET` ✅ | each order's item price while it's in flight |
| buyback | `BUYBACK_SECRET` ✅ | 4% of every sale (accumulates only — no $BID swap yet) |
| fee | `FEE_SECRET` ✅ | 1% of every sale **+ all shipping fees buyers pay** |

Ledger system accounts back these 1:1: `ESCROW` ↔ escrow wallet, buyback pool ↔
buyback wallet, fee pool ↔ fee wallet. The ledger stays the source of truth; the
wallets hold the actual USDC.

---

## 2. The two state machines

Escrow needs two coupled machines. **Order** = one won item; its money is held on
win and released on delivery. **Shipment** = a package grouping items from one
seller → one buyer (multiple wins can ship together); its delivery releases the
linked orders.

```
ORDER  (item price / escrow)
  win ──lock──► LOCKED ──(its Shipment delivered + 2-day window, no dispute)──► RELEASED
                  │                                                            95% seller
                  │                                                            4% buyback
                  │                                                            1% fee
                  ├─ no ship within 7 business days of buyer paying shipping ─► REFUNDED (item only)
                  └─ buyer disputes & wins ──────────────────────────────────► REFUNDED (item only)

SHIPMENT  (fulfillment / label)  — one Shipment gates one-or-more Orders
  won item ─► "Waiting for Buyer Shipping Order"   (ship-later: buyer hasn't paid shipping)
                    │ buyer pays shipping (USDC → fee wallet)
                    ▼
             "Need to be shipped"  ── seller selects items (may combine same-buyer wins),
                    │                  enters package dimensions + estimated weight → Confirm
                    ▼
        "Shipping Label Being Created" ── admin creates + attaches the label, presses "Label created"
                    │                      → emails seller
                    ▼
     "Label Created, Waiting to be Shipped"  (+ download-label link for the seller)
                    │ seller ships; Shippo tracks the number
                    ▼
                 SHIPPED ──(Shippo: delivered)──► DELIVERED → opens the 2-day window on the order(s)
```

---

## 3. Money moves (exact)

All amounts USDC micro-units; every ledger op is double-entry (legs sum to zero)
and idempotent per order/shipment.

| Event | Ledger | Chain (real USDC) |
|---|---|---|
| **Win → lock** | buyer → ESCROW (100% item price) | treasury → escrow |
| **Buyer pays shipping** | buyer → fee pool (full shipping fee; seller gets nothing here) | treasury → fee |
| **Release — seller 95%** | ESCROW → seller | escrow → treasury (backs withdrawable balance) |
| **Release — buyback 4%** | ESCROW → buyback pool | escrow → buyback |
| **Release — fee 1%** | ESCROW → fee pool | escrow → fee |
| **Refund (item only)** | ESCROW → buyer | escrow → treasury |

Fee split is **95 / 4 / 1** (seller / buyback / fee), replacing today's 95/5.
Rounding remainder goes to the seller so the three legs always sum to the amount.
Fees are moved **on release**, never on lock. The 4% just piles up in the buyback
wallet — no swap is built yet.

**Shipping is never refunded.** Once a buyer pays shipping it's terminal revenue in
the fee wallet — not returned on a no-ship timeout and not returned on a won
dispute. Refunds only ever return the item price from escrow.

---

## 4. Seller fulfillment UI

The seller's shipments page has two buckets:

- **"Need to be shipped"** — items whose shipping the buyer has already paid.
  Actionable: select items (combining multiple orders to the same buyer into one
  package is allowed), enter package **dimensions + estimated weight**, hit
  **Confirm** → the package moves to "Shipping Label Being Created".
- **"Waiting for Buyer Shipping Order"** — items on ship-later whose buyer hasn't
  paid shipping yet. Not actionable until the buyer pays.

After confirm the seller sees the package go: *Shipping Label Being Created* →
(admin acts) → *Label Created, Waiting to be Shipped* with a **download-label**
link. They download it, ship, done.

---

## 5. Admin (operator) controls

**Label queue** — `/admin` shows every package **waiting for a label**. Each row
expands to show:
- the items in the package (dropdown),
- package dimensions + weight,
- seller name + address, buyer name + address,
- shipping amount the buyer paid.

The operator creates the label externally, **attaches the label file** (upload /
link), and presses **"Label created"** → this emails the seller, flips the package
to *Label Created, Waiting to be Shipped*, exposes the download link, and arms
Shippo tracking on the number.

**Testing overrides** — while we validate escrow, the operator can manually mark an
order/shipment **label-created → shipped → delivered**, and **release payment
immediately** (skip the 2-day window). These sit alongside the automatic path.

---

## 6. Delivery, disputes, timers

- **Delivery**: Shippo tracking (sandbox/test mode first) flips a shipment to
  DELIVERED, which opens the dispute window on each order in it.
- **Dispute window: 2 days** (per order). Buyer may dispute; the operator resolves
  RELEASE or REFUND. No dispute in 2 days → auto-release.
- **No-ship timeout: 7 business days**, counted **from when the buyer pays
  shipping**. If the seller hasn't shipped by then: cancel the label, **refund the
  item price** (escrow → buyer), keep the shipping fee.

---

## 7. On-chain legs to harden (durable settlement)

Every leg below currently uses the blocking `chain.transfer()` — the same pattern
that caused the withdrawal double-spend. Each becomes a durable send + status +
reconcile (reuse `sendTransfer` / `getTransferStatus` / the reconciler from the
withdrawal fix). Reverse/retry only on a chain-proven outcome, never on a timeout.

1. lock: treasury → escrow (on win)
2. shipping: treasury → fee (on buyer pays shipping)
3. release-seller: escrow → treasury (95%)
4. release-buyback: escrow → buyback (4%)
5. release-fee: escrow → fee (1%)
6. refund: escrow → treasury (item only)

---

## 8. Buyer never pays shipping → buyer forfeits

The item price is escrowed on win, but shipping is a separate, later payment. If a
ship-later buyer **never** pays shipping, then when the ship-later hold expires the
order **releases to the seller** — the buyer forfeits. It settles exactly like a
normal release (95 / 4 / 1; the win was final, the buyer just abandoned it), and
the card stays with the seller to keep or relist. This is the standard release
path triggered by hold-expiry instead of by delivery.

---

## 9. Build sequence

1. 95/4/1 split + fee/buyback/shipping ledger accounts + wallet wiring.
2. Wire `settleAuction` (escrow mode) to create FulfillmentItems so escrow uses the
   shipping pipeline (today only direct mode does).
3. Shipping fee routes to the fee pool/wallet (not the seller).
4. Seller tabs ("Need to be shipped" / "Waiting for Buyer Shipping Order") + confirm-with-dims.
5. Admin label queue + attach-label + "Label created" + seller email.
6. Shippo tracking integration → delivered → 2-day window → auto-release.
7. Admin testing overrides (mark states / release now).
8. **Harden all 6 on-chain legs** (durable settlement) — last.
9. Devnet dry-run of the whole path on real USDC, then flip `BIDIT_PAYOUT_MODE`.
