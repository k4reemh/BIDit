/**
 * NFT chain seam: detect NFTs sitting at BIDit deposit wallets, read their
 * metadata, and transfer them out (winner withdrawals). Same provider pattern as
 * pump-provider / stream provider: a deterministic mock for dev + tests, a real
 * Solana implementation validated against mainnet via the runbook.
 *
 * Custody model: the token stays physically in the DEPOSITOR's derived deposit
 * wallet (BIDit controls the key); ownership changes are ledger rows (NftAsset),
 * so an auction "delivery" is instant and free. Only a withdrawal touches the
 * chain: an SPL transfer of amount 1, signed by the custody wallet with the
 * TREASURY paying the network fee + the recipient's token-account rent (deposit
 * wallets hold no SOL; the sweeper keeps them empty).
 *
 * v1 scope: classic SPL NFTs (token accounts with amount 1 / decimals 0).
 * Compressed NFTs never appear as token accounts, so they are naturally out of
 * scope; programmable NFTs (pNFTs) can be frozen and refuse plain SPL transfers,
 * so metadata flags them and the deposit UI warns before a user sends one.
 */

export interface CustodyNft {
  mint: string;
}

export interface NftMetadata {
  name: string | null;
  image: string | null;
  collection: string | null;
  /** Metaplex token standard when known; 'ProgrammableNonFungible' = pNFT. */
  standard: string | null;
}

export interface NftChain {
  readonly mode: 'mock' | 'solana';
  /** NFTs (amount 1 / decimals 0 token accounts) held by a deposit address. */
  listNfts(depositAddress: string): Promise<CustodyNft[]>;
  /** Best-effort metadata for a mint (name/image/collection). Null on failure:
   *  an unnamed NFT is still custody-tracked and withdrawable. */
  metadata(mint: string): Promise<NftMetadata | null>;
  /**
   * Transfer the NFT out of custody to `toAddress` and confirm. Retry-safe by
   * construction: amount is 1, so if an ambiguous earlier attempt actually
   * landed, the retry fails with an empty balance instead of double-sending;
   * callers treat "source has no token" as already-sent.
   */
  sendNft(custodyUserId: string, mint: string, toAddress: string): Promise<string>;
  isValidAddress(address: string): boolean;
}

// ---------------------------------------------------------------------------
// Mock: in-memory custody, test knobs mirror MockChain's style.
// ---------------------------------------------------------------------------

export class MockNftChain implements NftChain {
  readonly mode = 'mock' as const;
  /** depositAddress -> set of mints sitting there. */
  private readonly holdings = new Map<string, Set<string>>();
  private readonly meta = new Map<string, NftMetadata>();
  readonly sent: { custodyUserId: string; mint: string; to: string; sig: string }[] = [];
  private txN = 0;
  failNextSend = false;

  async listNfts(depositAddress: string): Promise<CustodyNft[]> {
    return [...(this.holdings.get(depositAddress) ?? [])].map((mint) => ({ mint }));
  }

  async metadata(mint: string): Promise<NftMetadata | null> {
    return this.meta.get(mint) ?? { name: `NFT ${mint.slice(0, 6)}`, image: null, collection: null, standard: 'NonFungible' };
  }

  async sendNft(custodyUserId: string, mint: string, to: string): Promise<string> {
    if (this.failNextSend) {
      this.failNextSend = false;
      throw new Error('mock send failure');
    }
    // Remove from whichever deposit address holds it (custody wallet).
    for (const set of this.holdings.values()) set.delete(mint);
    const sig = `nftsend_${++this.txN}`;
    this.sent.push({ custodyUserId, mint, to, sig });
    return sig;
  }

  isValidAddress(address: string): boolean {
    return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address);
  }

  // ---- test / dev knobs ----
  seedNft(depositAddress: string, mint: string, meta?: Partial<NftMetadata>): void {
    const set = this.holdings.get(depositAddress) ?? new Set<string>();
    set.add(mint);
    this.holdings.set(depositAddress, set);
    if (meta) {
      this.meta.set(mint, { name: null, image: null, collection: null, standard: 'NonFungible', ...meta });
    }
  }
}

// ---------------------------------------------------------------------------
// Factory: solana when the process is configured for a real chain, else mock.
// ---------------------------------------------------------------------------

export async function getNftChain(cluster: string): Promise<NftChain> {
  const forced = (process.env.BIDIT_NFT_CHAIN ?? '').trim().toLowerCase();
  if (forced === 'mock') return new MockNftChain();
  if (forced === 'solana' || cluster === 'mainnet-beta' || cluster === 'devnet') {
    const { SolanaNftChain } = await import('./nft-solana.js');
    return new SolanaNftChain();
  }
  return new MockNftChain();
}
