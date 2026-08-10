/**
 * Simulated chain for tests + local dev. Deterministic, in-memory, no network or
 * keys. Tracks per-address USDC balances and a queue of injected deposits, so the
 * full deposit -> escrow -> release -> buyback flow can be exercised exactly like
 * the real Solana path.
 */
import type { ChainClient, DepositEvent, SendResult, SolDepositEvent, SwapResult, TransferStatus, WalletName } from './types.js';

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
  /** Unswept native SOL sitting at deposit addresses (lamports), keyed by userId. */
  private readonly solPending = new Map<string, bigint>();
  /** Treasury's swept lamports: lets tests assert the sweep really moved SOL. */
  private treasuryLamports = 0n;
  private txN = 0;
  /** Default false so existing tests aren't all charged against the ATA budget. */
  private destsNeedFunding = false;
  private readonly fundedDests = new Set<string>();

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

  /** Sweep-and-report simulated native SOL, mirroring the Solana path: balances
   *  under minLamports stay put (dust accumulates toward the next deposit). */
  async pollSolDeposits(minLamports: bigint): Promise<SolDepositEvent[]> {
    const events: SolDepositEvent[] = [];
    for (const [userId, lamports] of this.solPending) {
      if (lamports < minLamports) continue;
      this.solPending.delete(userId);
      this.treasuryLamports += lamports;
      events.push({ userId, lamports, txSig: `solsweep_${++this.txN}` });
    }
    return events;
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
   *                         NOT move funds yet: a broadcast whose fate is still
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

  /** Mirrors Solana: a destination we have never paid is assumed to need its
   *  token account opened at our expense, unless a test says otherwise. */
  async destinationNeedsFunding(address: string): Promise<boolean> {
    return this.fundedDests.has(address) ? false : this.destsNeedFunding;
  }

  // ---- test helpers --------------------------------------------------------

  /** Whether unknown destinations report as needing a (treasury-funded) account. */
  setDestinationsNeedFunding(v: boolean): void {
    this.destsNeedFunding = v;
  }

  /** Mark a destination as already holding USDC, so paying it is free for us. */
  markDestinationFunded(address: string): void {
    this.fundedDests.add(address);
  }

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

  /** Simulate native SOL landing at a user's deposit address. It sits there
   *  (accumulating across calls) until pollSolDeposits sweeps it. */
  simulateSolDeposit(userId: string, lamports: bigint): void {
    this.solPending.set(userId, (this.solPending.get(userId) ?? 0n) + lamports);
  }

  /** Lamports the mock treasury has swept in (test assertion helper). */
  sweptLamports(): bigint {
    return this.treasuryLamports;
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

  /** Only treasury holds swept SOL in the mock; everything else reads 0. */
  async solBalanceLamports(target: WalletName | string): Promise<bigint> {
    return target === 'treasury' ? this.treasuryLamports : 0n;
  }

  // ---- auto-swap modelling -------------------------------------------------
  /** Simulated market rate: micro-USDC out per lamport in. Default ≈ $76.52/SOL
   *  (76_520_000 micro-USD / 1e9 lamports). Tests can move it to model slippage. */
  private swapRateMicroPerLamport = 76_520_000 / 1_000_000_000;
  private swapFailNext = false;

  /** Set the simulated SOL→USDC rate in whole USD per SOL (test helper). */
  setSwapPrice(usdPerSol: number): void {
    this.swapRateMicroPerLamport = (usdPerSol * 1_000_000) / 1_000_000_000;
  }
  /** Make the next swap throw (models a failed/again-later swap). */
  failNextSwap(): void {
    this.swapFailNext = true;
  }

  async swapSolToUsdc(lamports: bigint): Promise<SwapResult> {
    if (this.swapFailNext) {
      this.swapFailNext = false;
      throw new Error('mock: swap failed (no funds moved)');
    }
    if (lamports <= 0n) throw new Error('mock: swap amount must be positive');
    if (lamports > this.treasuryLamports) throw new Error('mock: swap exceeds treasury SOL');
    const usdcMicrosOut = BigInt(Math.floor(Number(lamports) * this.swapRateMicroPerLamport));
    this.treasuryLamports -= lamports;
    this.credit(this.wallets.treasury, usdcMicrosOut);
    return { lamportsIn: lamports, usdcMicrosOut, txSig: `mockswap_${++this.txN}` };
  }
}
