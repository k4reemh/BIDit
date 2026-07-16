/**
 * Simulated chain for tests + local dev. Deterministic, in-memory, no network or
 * keys. Tracks per-address USDC balances and a queue of injected deposits, so the
 * full deposit -> escrow -> release -> buyback flow can be exercised exactly like
 * the real Solana path.
 */
import type { ChainClient, DepositEvent, SendResult, TransferStatus, WalletName } from './types.js';

/** Internal bookkeeping for a broadcast (but not necessarily settled) transfer. */
interface PendingTransfer {
  from: WalletName;
  to: string;
  amount: bigint;
  status: TransferStatus;
  /** Whether the balance move has been applied (only ever done once, on confirm). */
  settled: boolean;
}

export class MockChain implements ChainClient {
  readonly cluster = 'mock' as const;

  private readonly wallets: Record<WalletName, string> = {
    treasury: 'mockTREASURY',
    escrow: 'mockESCROW',
    buyback: 'mockBUYBACK',
    fee: 'mockFEE',
  };
  private readonly bal = new Map<string, bigint>();
  private readonly userAddr = new Map<string, string>();
  private queue: DepositEvent[] = [];
  private txN = 0;

  // ---- withdrawal-path modelling ------------------------------------------
  private readonly transfers = new Map<string, PendingTransfer>();
  private failNext = false;
  private ambiguousNext = false;

  walletAddress(name: WalletName): string {
    return this.wallets[name];
  }

  async depositAddress(userId: string): Promise<string> {
    if (!this.userAddr.has(userId)) this.userAddr.set(userId, `mockDEPOSIT_${userId}`);
    return this.userAddr.get(userId)!;
  }

  async pollDeposits(_cursor: string | null): Promise<{ events: DepositEvent[]; cursor: string | null }> {
    const events = this.queue;
    this.queue = [];
    return { events, cursor: String(this.txN) };
  }

  async transfer(from: WalletName, to: string, amountMicros: bigint): Promise<string> {
    this.moveFunds(from, to, amountMicros);
    return `mocktx_${++this.txN}`;
  }

  /**
   * Broadcast without waiting for confirmation. Models the real chain's failure
   * surface so the withdrawal state machine can be tested exactly:
   *  - failNextSend():      throws BEFORE moving funds (pre-broadcast failure).
   *  - ambiguousNextSend(): returns a signature whose status is 'unknown' and does
   *                         NOT move funds yet — a broadcast whose fate is still
   *                         open. Resolve it later with resolveTransfer(sig, …).
   *  - default:             confirms immediately and moves the funds.
   */
  async sendTransfer(from: WalletName, to: string, amountMicros: bigint): Promise<SendResult> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error('mock: pre-broadcast send failure (no funds moved)');
    }
    const sig = `mocktx_${++this.txN}`;
    if (this.ambiguousNext) {
      this.ambiguousNext = false;
      this.transfers.set(sig, { from, to, amount: amountMicros, status: 'unknown', settled: false });
      return { sig, lastValidBlockHeight: null };
    }
    this.moveFunds(from, to, amountMicros);
    this.transfers.set(sig, { from, to, amount: amountMicros, status: 'confirmed', settled: true });
    return { sig, lastValidBlockHeight: null };
  }

  async getTransferStatus(sig: string): Promise<TransferStatus> {
    return this.transfers.get(sig)?.status ?? 'unknown';
  }

  isValidAddress(address: string): boolean {
    return typeof address === 'string' && address.trim().length > 0;
  }

  // ---- test helpers --------------------------------------------------------

  /** Make the next sendTransfer throw before broadcasting (funds never move). */
  failNextSend(): void {
    this.failNext = true;
  }

  /** Make the next sendTransfer return a signature that stays 'unknown' (an
   *  ambiguous, still-in-flight broadcast) until resolveTransfer is called. */
  ambiguousNextSend(): void {
    this.ambiguousNext = true;
  }

  /** Resolve a previously-ambiguous transfer. 'confirmed' applies the funds move
   *  now (as if it landed); 'failed' leaves balances untouched (it never landed). */
  resolveTransfer(sig: string, status: 'confirmed' | 'failed'): void {
    const t = this.transfers.get(sig);
    if (!t) throw new Error(`mock: no transfer ${sig}`);
    t.status = status;
    if (status === 'confirmed' && !t.settled) {
      this.moveFunds(t.from, t.to, t.amount);
      t.settled = true;
    }
  }

  /** Simulate a confirmed inbound USDC deposit; funds are swept into treasury. */
  simulateDeposit(userId: string, amountMicros: bigint, txSig = `dep_${++this.txN}`): void {
    this.queue.push({ userId, amountMicros, txSig });
    this.credit(this.wallets.treasury, amountMicros);
  }

  private moveFunds(from: WalletName, to: string, amt: bigint): void {
    this.debit(this.wallets[from], amt);
    this.credit(to, amt);
  }

  private credit(addr: string, amt: bigint): void {
    this.bal.set(addr, (this.bal.get(addr) ?? 0n) + amt);
  }

  private debit(addr: string, amt: bigint): void {
    this.bal.set(addr, (this.bal.get(addr) ?? 0n) - amt);
  }

  async balance(target: WalletName | string): Promise<bigint> {
    const addr = (this.wallets as Record<string, string>)[target] ?? target;
    return this.bal.get(addr) ?? 0n;
  }
}
