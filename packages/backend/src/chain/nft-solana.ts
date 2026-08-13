/**
 * Real NftChain against Solana. Exercised on mainnet via the runbook
 * (docs/NFT-AUCTIONS.md), not the in-process test suite (which uses the mock).
 *
 * - listNfts: parsed token accounts of the deposit wallet with amount 1 /
 *   decimals 0 (classic NFTs; cNFTs have no token account and stay out of scope).
 * - metadata: Helius DAS `getAsset` when SOLANA_RPC is a Helius endpoint (it is
 *   in prod); degrades to null metadata on any error so custody never blocks on
 *   a metadata read. Mind the Helius credit meter: one call per newly seen mint.
 * - sendNft: SPL transfer of 1, signed by the derived custody wallet, with the
 *   TREASURY as fee payer + rent payer for the recipient's token account
 *   (deposit wallets are deliberately SOL-empty; the sweeper keeps them so).
 */
import { Connection, Keypair, PublicKey, Transaction, sendAndConfirmTransaction } from '@solana/web3.js';
import {
  getAssociatedTokenAddress,
  getAccount,
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferInstruction,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import { deriveDepositKeypair } from '../wallet.js';
import type { CustodyNft, NftChain, NftMetadata } from './nft-chain.js';

function loadTreasury(): Keypair {
  const raw = (process.env.TREASURY_SECRET ?? '').trim();
  if (!raw) throw new Error('NFT chain: TREASURY_SECRET is required');
  const bytes = raw.startsWith('[') ? Uint8Array.from(JSON.parse(raw) as number[]) : Buffer.from(raw, 'base64');
  return Keypair.fromSecretKey(Uint8Array.from(bytes));
}

export class SolanaNftChain implements NftChain {
  readonly mode = 'solana' as const;
  private readonly conn: Connection;
  private readonly rpcUrl: string;
  private readonly treasury: Keypair;

  constructor() {
    this.rpcUrl = (process.env.SOLANA_RPC ?? '').trim();
    if (!this.rpcUrl) throw new Error('NFT chain: SOLANA_RPC is required');
    this.conn = new Connection(this.rpcUrl, 'confirmed');
    this.treasury = loadTreasury();
  }

  async listNfts(depositAddress: string): Promise<CustodyNft[]> {
    const res = await this.conn.getParsedTokenAccountsByOwner(new PublicKey(depositAddress), {
      programId: TOKEN_PROGRAM_ID,
    });
    const out: CustodyNft[] = [];
    for (const { account } of res.value) {
      const info = (account.data as { parsed?: { info?: { mint?: string; tokenAmount?: { amount?: string; decimals?: number } } } }).parsed?.info;
      if (info?.tokenAmount?.amount === '1' && info.tokenAmount.decimals === 0 && info.mint) {
        out.push({ mint: info.mint });
      }
    }
    return out;
  }

  async metadata(mint: string): Promise<NftMetadata | null> {
    try {
      // Helius DAS. On a non-Helius RPC this 404s and we degrade to null.
      const res = await fetch(this.rpcUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 'bidit-nft', method: 'getAsset', params: { id: mint } }),
        signal: AbortSignal.timeout(8000),
      });
      const body = (await res.json()) as {
        result?: {
          content?: { metadata?: { name?: string; token_standard?: string }; links?: { image?: string } };
          grouping?: { group_key?: string; group_value?: string }[];
        };
      };
      const r = body.result;
      if (!r) return null;
      return {
        name: r.content?.metadata?.name ?? null,
        image: r.content?.links?.image ?? null,
        collection: r.grouping?.find((g) => g.group_key === 'collection')?.group_value ?? null,
        standard: r.content?.metadata?.token_standard ?? null,
      };
    } catch {
      return null;
    }
  }

  async sendNft(custodyUserId: string, mint: string, toAddress: string): Promise<string> {
    const derived = deriveDepositKeypair(custodyUserId);
    const custody = Keypair.fromSecretKey(derived.secretKey);
    const mintPk = new PublicKey(mint);
    const toPk = new PublicKey(toAddress);
    const fromAta = await getAssociatedTokenAddress(mintPk, custody.publicKey);
    const toAta = await getAssociatedTokenAddress(mintPk, toPk);

    // Retry safety: if a previous ambiguous attempt landed, the source is empty.
    // Signal "already sent" distinctly so the worker can settle the withdrawal.
    try {
      const acct = await getAccount(this.conn, fromAta);
      if (acct.amount < 1n) throw new NftAlreadySentError(mint);
    } catch (err) {
      if (err instanceof NftAlreadySentError) throw err;
      // Token account missing entirely = the NFT left this wallet.
      throw new NftAlreadySentError(mint);
    }

    const tx = new Transaction().add(
      // Idempotent: a no-op when the recipient already has the token account.
      createAssociatedTokenAccountIdempotentInstruction(this.treasury.publicKey, toAta, toPk, mintPk),
      createTransferInstruction(fromAta, toAta, custody.publicKey, 1n),
    );
    tx.feePayer = this.treasury.publicKey;
    return sendAndConfirmTransaction(this.conn, tx, [this.treasury, custody], { commitment: 'confirmed' });
  }

  isValidAddress(address: string): boolean {
    try {
      // Base58 + on-curve check is intentionally NOT enforced (PDAs are valid
      // owners); constructing the PublicKey validates the encoding.
      void new PublicKey(address);
      return true;
    } catch {
      return false;
    }
  }
}

/** The source wallet no longer holds the token: an earlier send landed. */
export class NftAlreadySentError extends Error {
  constructor(mint: string) {
    super(`NFT ${mint} already left custody`);
    this.name = 'NftAlreadySentError';
  }
}
