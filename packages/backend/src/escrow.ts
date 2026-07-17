/**
 * The escrow wall. Everything money-into-escrow / out-of-escrow goes through this
 * one interface, so the rest of the system never knows whether funds are held in
 * a simulated ledger account (v1) or an on-chain PDA (later).
 *
 *   lock    buyer -> escrow         (no fee taken)
 *   release escrow -> 95% seller + 5% platform (buyback pool)
 *   refund  escrow -> 100% buyer    (fee never taken, so refunds are whole)
 *
 * DevWalletEscrow is fully simulated: it moves ledger entries only and touches NO
 * real funds or keys. ProgramEscrow (a later chunk) implements the same interface
 * against the real on-chain program and drops in without changing order logic.
 */
import { ESCROW_WALLET_ADDRESS, splitSale } from '@bidit/shared';
import { prisma as defaultPrisma } from './db.js';
import type { PrismaClient } from './db.js';
import {
  escrowLock,
  escrowRelease,
  escrowRefund,
  getOrCreateUserAccount,
} from './ledger.js';
import type { ChainClient } from './chain/index.js';

export type EscrowRef = string;

export interface EscrowProvider {
  /** Move `amountMicro` from buyer into escrow for `orderId`. Returns a reference. */
  lock(orderId: string, amountMicro: bigint, buyerRef: string, sellerRef: string): Promise<EscrowRef>;
  /** Release escrow: 5% -> buyback pool, 95% -> seller. */
  release(orderId: string): Promise<void>;
  /** Refund escrow: 100% -> buyer. */
  refund(orderId: string): Promise<void>;
}

/** v1 escrow — simulated, ledger-only. No chain, no keys, no real funds. */
export class DevWalletEscrow implements EscrowProvider {
  constructor(private readonly prisma: PrismaClient = defaultPrisma) {}

  async lock(
    orderId: string,
    amountMicro: bigint,
    buyerRef: string,
    _sellerRef: string,
  ): Promise<EscrowRef> {
    const order = await this.prisma.order.findUniqueOrThrow({
      where: { id: orderId },
      select: { auctionId: true },
    });
    await escrowLock(
      { buyerAccountId: buyerRef, amount: amountMicro, orderId, auctionId: order.auctionId },
      this.prisma,
    );
    return `devwallet:${ESCROW_WALLET_ADDRESS}:${orderId}`;
  }

  async release(orderId: string): Promise<void> {
    const order = await this.prisma.order.findUniqueOrThrow({
      where: { id: orderId },
      select: { amount: true, sellerId: true },
    });
    const sellerAccountId = await getOrCreateUserAccount(order.sellerId, this.prisma);
    await escrowRelease({ sellerAccountId, amount: order.amount, orderId }, this.prisma);
  }

  async refund(orderId: string): Promise<void> {
    const order = await this.prisma.order.findUniqueOrThrow({
      where: { id: orderId },
      select: { amount: true, buyerId: true },
    });
    const buyerAccountId = await getOrCreateUserAccount(order.buyerId, this.prisma);
    await escrowRefund({ buyerAccountId, amount: order.amount, orderId }, this.prisma);
  }
}

/**
 * On-chain escrow — the same ledger movements as DevWalletEscrow, but each also
 * ENQUEUES its internal wallet→wallet USDC move into the durable ChainTransfer
 * outbox, ATOMICALLY with the ledger write (one DB transaction). It does NOT
 * broadcast here: a ChainSettler drives each leg to the chain idempotently and
 * retries safely (all wallets are ours), so the ledger↔chain boundary can neither
 * lose funds nor double-move on a crash/timeout. MockChain makes it testable;
 * SolanaChain moves real USDC. Physical leg amounts equal the ledger amounts
 * (same splitSale), so the wallets converge exactly on the ledger accounts.
 */
export class ProgramEscrow implements EscrowProvider {
  constructor(
    private readonly chain: ChainClient,
    private readonly prisma: PrismaClient = defaultPrisma,
  ) {}

  async lock(
    orderId: string,
    amountMicro: bigint,
    buyerRef: string,
    _sellerRef: string,
  ): Promise<EscrowRef> {
    const order = await this.prisma.order.findUniqueOrThrow({
      where: { id: orderId },
      select: { auctionId: true },
    });
    await escrowLock(
      {
        buyerAccountId: buyerRef,
        amount: amountMicro,
        orderId,
        auctionId: order.auctionId,
        // Physical: treasury (pooled) → escrow wallet.
        chainLegs: [{ key: `lock:${orderId}`, fromWallet: 'treasury', toWallet: 'escrow', amount: amountMicro, memo: `lock:${orderId}` }],
      },
      this.prisma,
    );
    return `${this.chain.cluster}:escrow:${this.chain.walletAddress('escrow')}:${orderId}`;
  }

  async release(orderId: string): Promise<void> {
    const order = await this.prisma.order.findUniqueOrThrow({
      where: { id: orderId },
      select: { amount: true, sellerId: true },
    });
    const sellerAccountId = await getOrCreateUserAccount(order.sellerId, this.prisma);
    // Same split escrowRelease uses for the ledger → the physical legs match exactly.
    const { sellerProceeds, buybackFee, platformFee } = splitSale(order.amount);
    await escrowRelease(
      {
        sellerAccountId,
        amount: order.amount,
        orderId,
        chainLegs: [
          // 95% back to the pool (backs the seller's withdrawable balance).
          { key: `release-seller:${orderId}`, fromWallet: 'escrow', toWallet: 'treasury', amount: sellerProceeds, memo: `release-seller:${orderId}` },
          { key: `release-buyback:${orderId}`, fromWallet: 'escrow', toWallet: 'buyback', amount: buybackFee, memo: `release-buyback:${orderId}` },
          { key: `release-fee:${orderId}`, fromWallet: 'escrow', toWallet: 'fee', amount: platformFee, memo: `release-fee:${orderId}` },
        ],
      },
      this.prisma,
    );
  }

  async refund(orderId: string): Promise<void> {
    const order = await this.prisma.order.findUniqueOrThrow({
      where: { id: orderId },
      select: { amount: true, buyerId: true },
    });
    const buyerAccountId = await getOrCreateUserAccount(order.buyerId, this.prisma);
    await escrowRefund(
      {
        buyerAccountId,
        amount: order.amount,
        orderId,
        // Physical: escrow wallet → treasury (buyer's refund lands in their pooled balance).
        chainLegs: [{ key: `refund:${orderId}`, fromWallet: 'escrow', toWallet: 'treasury', amount: order.amount, memo: `refund:${orderId}` }],
      },
      this.prisma,
    );
  }
}
