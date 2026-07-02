/**
 * Simulated chain for tests + local dev. Deterministic, in-memory, no network or
 * keys. Tracks per-address USDC balances and a queue of injected deposits, so the
 * full deposit -> escrow -> release -> buyback flow can be exercised exactly like
 * the real Solana path.
 */
import type { ChainClient, DepositEvent, WalletName } from './types.js';

export class MockChain implements ChainClient {
  readonly cluster = 'mock' as const;

  private readonly wallets: Record<WalletName, string> = {
    treasury: 'mockTREASURY',
    escrow: 'mockESCROW',
    buyback: 'mockBUYBACK',
  };
  private readonly bal = new Map<string, bigint>();
  private readonly userAddr = new Map<string, string>();
  private queue: DepositEvent[] = [];
  private txN = 0;

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
    this.debit(this.wallets[from], amountMicros);
    this.credit(to, amountMicros);
    return `mocktx_${++this.txN}`;
  }

  async balance(target: WalletName | string): Promise<bigint> {
    const addr = (this.wallets as Record<string, string>)[target] ?? target;
    return this.bal.get(addr) ?? 0n;
  }

  // ---- test helpers --------------------------------------------------------

  /** Simulate a confirmed inbound USDC deposit; funds are swept into treasury. */
  simulateDeposit(userId: string, amountMicros: bigint, txSig = `dep_${++this.txN}`): void {
    this.queue.push({ userId, amountMicros, txSig });
    this.credit(this.wallets.treasury, amountMicros);
  }

  private credit(addr: string, amt: bigint): void {
    this.bal.set(addr, (this.bal.get(addr) ?? 0n) + amt);
  }

  private debit(addr: string, amt: bigint): void {
    this.bal.set(addr, (this.bal.get(addr) ?? 0n) - amt);
  }
}
