/**
 * Real Solana (devnet) implementation of ChainClient: moves actual SPL USDC.
 *
 * SAFETY: keypairs are loaded from env (never hardcoded/committed); the cluster
 * defaults to devnet and mainnet is refused unless BIDIT_ALLOW_MAINNET=yes. USDC
 * has 6 decimals, so micro-units map 1:1 to token base units, no floats.
 *
 * NOTE: this file is wired against @solana/web3.js but is exercised on real
 * devnet via the runbook (docs/DEVNET.md), not the in-process test suite. The
 * deposit poll uses a simple balance-delta-then-sweep strategy (each deposit
 * address is swept to treasury after crediting); a production deploy would use a
 * webhook/indexer (e.g. Helius) instead of polling.
 */
import { Connection, Keypair, PublicKey, Transaction, SystemProgram, sendAndConfirmTransaction, VersionedTransaction } from '@solana/web3.js';
import {
  getOrCreateAssociatedTokenAccount,
  getAssociatedTokenAddress,
  getAccount,
  createTransferInstruction,
  transfer as splTransfer,
} from '@solana/spl-token';
import bs58 from 'bs58';
import type { ChainClient, DepositEvent, SendResult, SolDepositEvent, SwapResult, TransferStatus, WalletName } from './types.js';
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
  fee: Keypair;
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
    this.wallets = { treasury: cfg.treasury, escrow: cfg.escrow, buyback: cfg.buyback, fee: cfg.fee };
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
      // On mainnet the deposit master seed controls real user funds: refuse the
      // insecure default so real money is never derived from a known seed.
      const seed = process.env.BIDIT_WALLET_SEED;
      if (!seed || seed === 'dev-insecure-wallet-seed-change-me' || seed.length < 24) {
        throw new Error('Refusing mainnet: set a strong, unique BIDIT_WALLET_SEED (>=24 chars).');
      }
    }
    const mint = process.env.USDC_MINT;
    if (!mint) throw new Error('Missing env USDC_MINT');
    const treasury = loadKeypair('TREASURY_SECRET');
    // In direct-payout mode escrow/buyback/fee are unused, so each falls back to
    // treasury when its secret is unset (single-wallet live test). For escrow mode
    // these MUST be distinct wallets or the on-chain legs become self-transfers:
    // the escrow launch checklist verifies they're set (see docs/ESCROW-DESIGN.md).
    const escrow = process.env.ESCROW_SECRET ? loadKeypair('ESCROW_SECRET') : treasury;
    const buyback = process.env.BUYBACK_SECRET ? loadKeypair('BUYBACK_SECRET') : treasury;
    const fee = process.env.FEE_SECRET ? loadKeypair('FEE_SECRET') : treasury;
    return new SolanaChain({
      connection: new Connection(rpc, 'confirmed'),
      cluster,
      usdcMint: new PublicKey(mint),
      treasury,
      escrow,
      buyback,
      fee,
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
    // Resolve any known wallet name (treasury/escrow/buyback/fee) via the record;
    // anything else is treated as a raw address. (Wallet names are never valid
    // base58 pubkeys, so there's no ambiguity.)
    const wallet = (this.wallets as Record<string, Keypair>)[target];
    const owner = wallet ? wallet.publicKey : new PublicKey(target);
    const ata = await getAssociatedTokenAddress(this.usdcMint, owner);
    try {
      return (await getAccount(this.conn, ata)).amount;
    } catch {
      return 0n; // no ATA yet
    }
  }

  /** Does this destination still need its USDC token account opened (at OUR
   *  expense)? Treated as "yes" if the lookup fails, so an RPC blip spends the
   *  caller's budget rather than silently handing out free rent. */
  async destinationNeedsFunding(address: string): Promise<boolean> {
    try {
      const ata = await getAssociatedTokenAddress(this.usdcMint, new PublicKey(address));
      await getAccount(this.conn, ata);
      return false; // already exists, costs us nothing
    } catch {
      return true;
    }
  }

  /** Native SOL balance (lamports) of a named wallet or raw address. */
  async solBalanceLamports(target: WalletName | string): Promise<bigint> {
    const pubkey = (this.wallets as Record<string, Keypair>)[target]?.publicKey ?? new PublicKey(target);
    return BigInt(await this.conn.getBalance(pubkey, 'confirmed'));
  }

  /**
   * Swap `lamports` of treasury SOL into USDC via Jupiter (mainnet aggregator).
   * The auto-swap worker calls this so deposited SOL becomes the USDC that backs
   * user balances. Actual USDC received is measured by the treasury USDC balance
   * delta (not the quote), so the audit record reflects reality after slippage.
   * Throws on any failure — the worker retries next tick and no record is written.
   */
  async swapSolToUsdc(lamports: bigint): Promise<SwapResult> {
    if (lamports <= 0n) throw new Error('swap amount must be positive');
    const SOL_MINT = 'So11111111111111111111111111111111111111112';
    const slippageBps = Number(process.env.BIDIT_SWAP_SLIPPAGE_BPS ?? 100);
    const treasury = this.wallets.treasury;

    // 1. Quote.
    const quoteUrl =
      `https://quote-api.jup.ag/v6/quote?inputMint=${SOL_MINT}&outputMint=${this.usdcMint.toBase58()}` +
      `&amount=${lamports.toString()}&slippageBps=${slippageBps}`;
    const quoteRes = await fetch(quoteUrl, { signal: AbortSignal.timeout(8000) });
    if (!quoteRes.ok) throw new Error(`jupiter quote → ${quoteRes.status}`);
    const quote = (await quoteRes.json()) as { outAmount?: string };
    if (!quote?.outAmount) throw new Error('jupiter quote: no route');

    // 2. Build the swap tx (Jupiter returns a signed-by-nobody versioned tx).
    const swapRes = await fetch('https://quote-api.jup.ag/v6/swap', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        quoteResponse: quote,
        userPublicKey: treasury.publicKey.toBase58(),
        wrapAndUnwrapSol: true, // pull native SOL, deliver native USDC
        dynamicComputeUnitLimit: true,
      }),
      signal: AbortSignal.timeout(8000),
    });
    if (!swapRes.ok) throw new Error(`jupiter swap → ${swapRes.status}`);
    const { swapTransaction } = (await swapRes.json()) as { swapTransaction?: string };
    if (!swapTransaction) throw new Error('jupiter swap: no transaction');

    // 3. Measure the real USDC received via a balance delta around the swap.
    const usdcBefore = await this.balance('treasury');
    const tx = VersionedTransaction.deserialize(Buffer.from(swapTransaction, 'base64'));
    tx.sign([treasury]);
    const sig = await this.conn.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 5 });
    const { blockhash, lastValidBlockHeight } = await this.conn.getLatestBlockhash('confirmed');
    await this.conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed');
    const usdcAfter = await this.balance('treasury');
    const usdcMicrosOut = usdcAfter - usdcBefore;
    if (usdcMicrosOut <= 0n) throw new Error(`swap ${sig} confirmed but treasury USDC did not increase`);
    return { lamportsIn: lamports, usdcMicrosOut, txSig: sig };
  }

  async transfer(from: WalletName, to: string, amountMicros: bigint): Promise<string> {
    const owner = this.wallets[from];
    const fromAta = await getOrCreateAssociatedTokenAccount(this.conn, owner, this.usdcMint, owner.publicKey);
    const toAta = await getOrCreateAssociatedTokenAccount(this.conn, owner, this.usdcMint, new PublicKey(to));
    return splTransfer(this.conn, owner, fromAta.address, toAta.address, owner, amountMicros);
  }

  /**
   * Broadcast a transfer WITHOUT waiting for confirmation (withdrawal rail).
   *
   * All fallible pre-broadcast work: ensuring the ATAs, fetching the blockhash,
   * building and signing: happens first; if any of it throws, the value transfer
   * never went out and the caller can safely reverse. Once we've signed, the
   * signature is fixed (a property of the signed bytes), so we return it even if
   * the `sendRawTransaction` ack is lost to a timeout: the tx may still land, and
   * getTransferStatus is the only thing allowed to declare it dead.
   */
  async sendTransfer(from: WalletName, to: string, amountMicros: bigint): Promise<SendResult> {
    const owner = this.wallets[from];
    // Pre-broadcast setup (throwing here means no value moved → safe to reverse).
    const fromAta = await getOrCreateAssociatedTokenAccount(this.conn, owner, this.usdcMint, owner.publicKey);
    const toAta = await getOrCreateAssociatedTokenAccount(this.conn, owner, this.usdcMint, new PublicKey(to));
    const { blockhash, lastValidBlockHeight } = await this.conn.getLatestBlockhash('confirmed');
    const tx = new Transaction({ feePayer: owner.publicKey, blockhash, lastValidBlockHeight });
    tx.add(createTransferInstruction(fromAta.address, toAta.address, owner.publicKey, amountMicros));
    tx.sign(owner);
    const sig = bs58.encode(tx.signature!); // signature is fixed once signed
    // From here the tx exists and may land; a send error must NOT be treated as
    // failure (that is the double-spend trap). Swallow it and resolve fate later.
    try {
      await this.conn.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 5 });
    } catch (err) {
      console.warn(`[withdraw] send ack lost for ${sig} (will reconcile):`, (err as Error)?.message ?? err);
    }
    return { sig, lastValidBlockHeight: BigInt(lastValidBlockHeight) };
  }

  async getTransferStatus(sig: string, lastValidBlockHeight?: bigint | null): Promise<TransferStatus> {
    const { value } = await this.conn.getSignatureStatuses([sig], { searchTransactionHistory: true });
    const st = value[0];
    if (st) {
      if (st.err) return 'failed'; // processed but reverted: the transfer did not move funds
      if (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized') return 'confirmed';
      return 'unknown'; // 'processed' only, not yet safely confirmed
    }
    // Not found on-chain. If its blockhash has expired, it can never land → dead.
    if (lastValidBlockHeight != null) {
      const height = await this.conn.getBlockHeight('confirmed');
      if (BigInt(height) > lastValidBlockHeight) return 'failed';
    }
    return 'unknown'; // still within the validity window (or unknown expiry): keep waiting
  }

  isValidAddress(address: string): boolean {
    try {
      // Rejects wrong length, bad base58, and off-curve junk before we ever debit.
      new PublicKey(address);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Naive poll: any positive balance on a known deposit address is a new deposit;
   * we sweep it into treasury (treasury pays fees) and emit an event keyed by the
   * sweep signature for idempotent ledger crediting.
   */
  /**
   * Sweep any USDC sitting at users' deposit addresses into the treasury, and
   * report what moved so the ledger can credit it.
   *
   * Balance discovery is BATCHED. This used to `await` one RPC call per user in
   * a serial loop, so cost and wall-clock grew with signups: at 600 users a
   * single poll made 600 sequential round trips and could not finish inside its
   * own interval, while burning RPC quota continuously. Associated-token
   * addresses are derived locally (no network), so one
   * `getMultipleAccountsInfo` covers 100 users, and only the addresses that
   * actually hold a balance go on to do transfer work.
   */
  async pollDeposits(_cursor: string | null): Promise<{ events: DepositEvent[]; cursor: string | null }> {
    const events: DepositEvent[] = [];
    const treasury = this.wallets.treasury;

    const owners = [...this.depositOwners.entries()];
    if (owners.length === 0) return { events, cursor: null };

    // 1. Derive every ATA locally, then read them in batches of 100.
    const atas = await Promise.all(
      owners.map(([, kp]) => getAssociatedTokenAddress(this.usdcMint, kp.publicKey)),
    );
    const funded: { userId: string; depositKp: Keypair }[] = [];
    const BATCH = 100;
    for (let i = 0; i < atas.length; i += BATCH) {
      const slice = atas.slice(i, i + BATCH);
      let infos: (Awaited<ReturnType<Connection['getMultipleAccountsInfo']>>[number])[] = [];
      try {
        infos = await this.conn.getMultipleAccountsInfo(slice);
      } catch (err) {
        // A failed batch is retried on the next poll; never abort the sweep.
        console.error('[deposit-sweep] balance batch failed (will retry):', (err as Error)?.message ?? err);
        continue;
      }
      infos.forEach((info, j) => {
        if (!info) return; // no ATA yet, so nothing was ever sent here
        // SPL token account layout: amount is a u64 at offset 64.
        const amount = info.data.length >= 72 ? info.data.readBigUInt64LE(64) : 0n;
        if (amount > 0n) {
          const [userId, depositKp] = owners[i + j]!;
          funded.push({ userId, depositKp });
        }
      });
    }
    if (funded.length === 0) return { events, cursor: null };

    // 2. Only addresses actually holding USDC do transfer work.
    for (const { userId, depositKp } of funded) {
      // Each address is swept in its own try/catch. A failure here (treasury out
      // of SOL for fees, an RPC hiccup, an ATA-creation race) must NEVER abort the
      // poll or crash the process: the user's USDC stays safe at their deposit
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

  /**
   * Sweep native SOL sitting at users' deposit addresses into treasury, and
   * report the lamports moved so the ledger can credit a USDC-denominated amount
   * at the oracle price. Sweep-and-report like pollDeposits: an event exists only
   * after the lamports are confirmed in treasury, and the sweep signature is the
   * idempotency key. Balances under `minLamports` are left as dust (not worth the
   * fee) and count toward the user's next deposit.
   *
   * The deposit address is a plain system account, so its whole balance is swept
   * to zero. Treasury is the fee payer (so the account can drain completely) and
   * the deposit keypair signs to authorize the debit.
   */
  async pollSolDeposits(minLamports: bigint): Promise<SolDepositEvent[]> {
    const events: SolDepositEvent[] = [];
    const treasury = this.wallets.treasury;
    const owners = [...this.depositOwners.entries()];
    if (owners.length === 0) return events;

    // 1. Read native lamports of every deposit owner account, batched.
    const funded: { userId: string; depositKp: Keypair; lamports: bigint }[] = [];
    const BATCH = 100;
    for (let i = 0; i < owners.length; i += BATCH) {
      const slice = owners.slice(i, i + BATCH).map(([, kp]) => kp.publicKey);
      let infos: (Awaited<ReturnType<Connection['getMultipleAccountsInfo']>>[number])[] = [];
      try {
        infos = await this.conn.getMultipleAccountsInfo(slice);
      } catch (err) {
        console.error('[sol-sweep] balance batch failed (will retry):', (err as Error)?.message ?? err);
        continue;
      }
      infos.forEach((info, j) => {
        const lamports = info ? BigInt(info.lamports) : 0n;
        if (lamports >= minLamports) {
          const [userId, depositKp] = owners[i + j]!;
          funded.push({ userId, depositKp, lamports });
        }
      });
    }
    if (funded.length === 0) return events;

    // 2. Sweep each funded address to zero. Re-read the balance immediately
    //    before building the tx so we move exactly what's there right now.
    for (const { userId, depositKp } of funded) {
      try {
        const lamports = BigInt(await this.conn.getBalance(depositKp.publicKey, 'confirmed'));
        if (lamports < minLamports) continue;
        const { blockhash, lastValidBlockHeight } = await this.conn.getLatestBlockhash('confirmed');
        const tx = new Transaction({ feePayer: treasury.publicKey, blockhash, lastValidBlockHeight });
        tx.add(
          SystemProgram.transfer({
            fromPubkey: depositKp.publicKey,
            toPubkey: treasury.publicKey,
            lamports, // drain fully; treasury pays the fee so this can hit zero
          }),
        );
        // treasury signs as fee payer, the deposit keypair authorizes the debit.
        const sig = await sendAndConfirmTransaction(this.conn, tx, [treasury, depositKp], {
          commitment: 'confirmed',
        });
        events.push({ userId, lamports, txSig: sig });
      } catch (err) {
        console.error(`[sol-sweep] userId=${userId} failed (will retry next poll):`, (err as Error)?.message ?? err);
      }
    }
    return events;
  }
}
