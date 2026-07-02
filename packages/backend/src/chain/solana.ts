/**
 * Real Solana (devnet) implementation of ChainClient — moves actual SPL USDC.
 *
 * SAFETY: keypairs are loaded from env (never hardcoded/committed); the cluster
 * defaults to devnet and mainnet is refused unless BIDIT_ALLOW_MAINNET=yes. USDC
 * has 6 decimals, so micro-units map 1:1 to token base units — no floats.
 *
 * NOTE: this file is wired against @solana/web3.js but is exercised on real
 * devnet via the runbook (docs/DEVNET.md), not the in-process test suite. The
 * deposit poll uses a simple balance-delta-then-sweep strategy (each deposit
 * address is swept to treasury after crediting); a production deploy would use a
 * webhook/indexer (e.g. Helius) instead of polling.
 */
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import {
  getOrCreateAssociatedTokenAccount,
  getAssociatedTokenAddress,
  getAccount,
  transfer as splTransfer,
} from '@solana/spl-token';
import bs58 from 'bs58';
import type { ChainClient, DepositEvent, WalletName } from './types.js';
import { deriveDepositKeypair as walletDeriveDepositKeypair } from '../wallet.js';

function loadKeypair(envVar: string): Keypair {
  const raw = process.env[envVar];
  if (!raw) throw new Error(`Missing env ${envVar} (a base58 secret key or JSON byte array)`);
  const trimmed = raw.trim();
  const bytes = trimmed.startsWith('[')
    ? Uint8Array.from(JSON.parse(trimmed) as number[])
    : bs58.decode(trimmed);
  return Keypair.fromSecretKey(bytes);
}

interface SolanaConfig {
  connection: Connection;
  cluster: 'devnet' | 'mainnet-beta';
  usdcMint: PublicKey;
  treasury: Keypair;
  escrow: Keypair;
  buyback: Keypair;
  depositSeed: string;
}

export class SolanaChain implements ChainClient {
  readonly cluster: 'devnet' | 'mainnet-beta';
  private readonly conn: Connection;
  private readonly usdcMint: PublicKey;
  private readonly wallets: Record<WalletName, Keypair>;
  private readonly depositSeed: string;
  private readonly depositOwners = new Map<string, Keypair>();

  constructor(cfg: SolanaConfig) {
    this.conn = cfg.connection;
    this.cluster = cfg.cluster;
    this.usdcMint = cfg.usdcMint;
    this.wallets = { treasury: cfg.treasury, escrow: cfg.escrow, buyback: cfg.buyback };
    this.depositSeed = cfg.depositSeed;
  }

  static fromEnv(): SolanaChain {
    const rpc = process.env.SOLANA_RPC;
    if (!rpc) throw new Error('Missing env SOLANA_RPC');
    const cluster = (process.env.SOLANA_CLUSTER ?? 'devnet') as 'devnet' | 'mainnet-beta';
    if (cluster === 'mainnet-beta') {
      if (process.env.BIDIT_ALLOW_MAINNET !== 'yes') {
        throw new Error('Refusing mainnet-beta without BIDIT_ALLOW_MAINNET=yes');
      }
      // On mainnet the deposit master seed controls real user funds — refuse the
      // insecure default so real money is never derived from a known seed.
      const seed = process.env.BIDIT_WALLET_SEED;
      if (!seed || seed === 'dev-insecure-wallet-seed-change-me' || seed.length < 24) {
        throw new Error('Refusing mainnet: set a strong, unique BIDIT_WALLET_SEED (>=24 chars).');
      }
    }
    const mint = process.env.USDC_MINT;
    if (!mint) throw new Error('Missing env USDC_MINT');
    const treasury = loadKeypair('TREASURY_SECRET');
    // escrow/buyback are unused in direct-payout mode — fall back to treasury so
    // the operator only has to configure one hot wallet for the live test.
    const escrow = process.env.ESCROW_SECRET ? loadKeypair('ESCROW_SECRET') : treasury;
    const buyback = process.env.BUYBACK_SECRET ? loadKeypair('BUYBACK_SECRET') : treasury;
    return new SolanaChain({
      connection: new Connection(rpc, 'confirmed'),
      cluster,
      usdcMint: new PublicKey(mint),
      treasury,
      escrow,
      buyback,
      depositSeed: process.env.DEPOSIT_SEED ?? 'bidit-deposit-seed',
    });
  }

  walletAddress(name: WalletName): string {
    return this.wallets[name].publicKey.toBase58();
  }

  async depositAddress(userId: string): Promise<string> {
    const kp = this.deriveDepositKeypair(userId);
    this.depositOwners.set(userId, kp);
    return kp.publicKey.toBase58();
  }

  private deriveDepositKeypair(userId: string): Keypair {
    // Use the ONE canonical derivation (wallet.ts, HMAC-SHA256 over the operator
    // master seed) so the address a user is shown is EXACTLY the address we watch
    // and sweep. (A second, divergent scheme here would strand deposits.)
    return Keypair.fromSecretKey(walletDeriveDepositKeypair(userId).secretKey);
  }

  async balance(target: WalletName | string): Promise<bigint> {
    const owner =
      target === 'treasury' || target === 'escrow' || target === 'buyback'
        ? this.wallets[target].publicKey
        : new PublicKey(target);
    const ata = await getAssociatedTokenAddress(this.usdcMint, owner);
    try {
      return (await getAccount(this.conn, ata)).amount;
    } catch {
      return 0n; // no ATA yet
    }
  }

  async transfer(from: WalletName, to: string, amountMicros: bigint): Promise<string> {
    const owner = this.wallets[from];
    const fromAta = await getOrCreateAssociatedTokenAccount(this.conn, owner, this.usdcMint, owner.publicKey);
    const toAta = await getOrCreateAssociatedTokenAccount(this.conn, owner, this.usdcMint, new PublicKey(to));
    return splTransfer(this.conn, owner, fromAta.address, toAta.address, owner, amountMicros);
  }

  /**
   * Naive poll: any positive balance on a known deposit address is a new deposit;
   * we sweep it into treasury (treasury pays fees) and emit an event keyed by the
   * sweep signature for idempotent ledger crediting.
   */
  async pollDeposits(_cursor: string | null): Promise<{ events: DepositEvent[]; cursor: string | null }> {
    const events: DepositEvent[] = [];
    const treasury = this.wallets.treasury;
    for (const [userId, depositKp] of this.depositOwners) {
      // Each address is swept in its own try/catch. A failure here (treasury out
      // of SOL for fees, an RPC hiccup, an ATA-creation race) must NEVER abort the
      // poll or crash the process — the user's USDC stays safe at their deposit
      // address and the sweep is retried on the next poll once the cause clears.
      try {
        const amount = await this.balance(depositKp.publicKey.toBase58());
        if (amount <= 0n) continue;
        const fromAta = await getOrCreateAssociatedTokenAccount(this.conn, treasury, this.usdcMint, depositKp.publicKey);
        const toAta = await getOrCreateAssociatedTokenAccount(this.conn, treasury, this.usdcMint, treasury.publicKey);
        // treasury pays the fee; the deposit keypair authorizes the move.
        const sig = await splTransfer(this.conn, treasury, fromAta.address, toAta.address, depositKp, amount);
        events.push({ userId, amountMicros: amount, txSig: sig });
      } catch (err) {
        console.error(`[deposit-sweep] userId=${userId} failed (will retry next poll):`, (err as Error)?.message ?? err);
      }
    }
    return { events, cursor: null };
  }
}
