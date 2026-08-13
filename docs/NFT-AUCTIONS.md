# NFT custody + NFT auctions

Sellers deposit Solana NFTs into BIDit, auction them live on stream or as timed
marketplace auctions (single or batch), and the winner gets them instantly. The
seller is paid their 95% the moment the hammer falls.

## How it works

- **Deposit**: the user opens Account → My NFTs → "Show my deposit address" and
  sends the NFT to their existing BIDit deposit wallet (same address as USDC/SOL
  deposits). Opening the flow arms a 30-minute watch window; the watcher
  (`creditNftDeposits`, 20s tick) only scans armed users, so an idle site makes
  zero NFT RPC calls.
- **Custody**: the token STAYS in the depositor's derived deposit wallet
  (`custodyUserId`); BIDit controls the key. Ownership is the `NftAsset.ownerId`
  ledger row. An auction win reassigns `ownerId` — instant, free, no chain tx.
- **Auction**: an NFT listing is a normal `Listing` (`nft=true`) whose photos and
  title come from the assets. Stream mode queues it for the seller's live room;
  market mode starts a timed marketplace auction immediately. Batch = up to 10
  assets on one listing; the winner takes all of them.
- **Settle**: `creditNftWin` moves the assets to the buyer, then the order is
  released immediately (LOCKED → RELEASED, fee taken at release): no dispute
  window, because delivery already happened and is verifiable. Seller nets 95%
  on the spot. No shipment, no fulfillment item.
- **Withdraw**: any HELD asset not attached to an active listing. The worker
  (`processNftWithdrawals`, 30s tick) sends an SPL transfer of 1 signed by the
  custody wallet, with the TREASURY paying the network fee and the recipient's
  token-account rent (deposit wallets are deliberately SOL-empty). Retry-safe:
  an amount-1 transfer can't double-send; "source empty" settles as sent.

## Providers

`src/chain/nft-chain.ts` — seam + `MockNftChain` (dev/tests).
`src/chain/nft-solana.ts` — real implementation: parsed token accounts
(amount 1 / decimals 0), Helius DAS `getAsset` metadata, SPL transfer with
treasury fee-payer. Selected automatically on mainnet/devnet;
`BIDIT_NFT_CHAIN=mock|solana` overrides. No new env vars: it reuses
`SOLANA_RPC` and `TREASURY_SECRET`.

## Scope (v1)

- Classic SPL NFTs only. Compressed NFTs (cNFTs) have no token account and are
  never detected — a user cannot strand one here.
- Programmable NFTs (pNFTs) ARE detected and flagged (`standard`), and the UI
  warns that withdrawals may need support: a frozen pNFT refuses plain SPL
  transfers. If one gets stuck, moving it needs a Metaplex transfer with auth
  rules (operator task). Supporting them natively is the known follow-up.

## Mainnet validation (Kareem — I cannot run mainnet txs)

1. Deploy; `/health` unchanged (NFT chain picks solana automatically on mainnet).
2. With a throwaway wallet holding a cheap NFT: My NFTs → arm → send the NFT to
   your deposit address → it appears within ~1 min with name/image (DAS).
   Watch the Helius credit meter: 1 getAsset per new mint + 1
   getParsedTokenAccountsByOwner per armed user per 20s tick.
3. Withdraw it back to the throwaway → arrives; treasury paid fee + rent
   (~0.002 SOL when the destination needs a new token account).
4. Deposit again → auction it on the marketplace (30-min run) from a second
   account, bid, win → winner sees it in My NFTs instantly, seller balance +95%
   at close, winner withdraws to a third wallet.
5. Batch: deposit 2+, list as one batch on stream, run it live, win → both
   credited.
6. Failure drills: withdraw to a fresh (rent-needed) address; kill the backend
   mid-withdraw and confirm the retry settles it without a double-send.
