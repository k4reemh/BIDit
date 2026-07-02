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
import { ESCROW_WALLET_ADDRESS } from '@bidit/shared';
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
 * On-chain escrow — does the same ledger movements as DevWalletEscrow AND the
 * real USDC transfers via the chain client (custodial wallet now; an on-chain PDA
 * program later, same interface). MockChain makes it fully testable; SolanaChain
 * moves real devnet USDC. The order state machine guarantees lock/release/refund
 * run once per order, so there's no on-chain double-spend.
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
      { buyerAccountId: buyerRef, amount: amountMicro, orderId, auctionId: order.auctionId },
      this.prisma,
    );
    const txSig = await this.chain.transfer(
      'treasury',
      this.chain.walletAddress('escrow'),
      amountMicro,
      `lock:${orderId}`,
    );
    return `${this.chain.cluster}:escrow:${this.chain.walletAddress('escrow')}:${orderId}:${txSig}`;
  }

  async release(orderId: string): Promise<void> {
    const order = await this.prisma.order.findUniqueOrThrow({
      where: { id: orderId },
      select: { amount: true, sellerId: true },
    });
    const sellerAccountId = await getOrCreateUserAccount(order.sellerId, this.prisma);
    const { platformFee, sellerProceeds } = await escrowRelease(
      { sellerAccountId, amount: order.amount, orderId },
      this.prisma,
    );
    // 95% back to the pool (seller's custodial balance), 5% to the buyback wallet.
    if (sellerProceeds > 0n) {
      await this.chain.transfer('escrow', this.chain.walletAddress('treasury'), sellerProceeds, `release-seller:${orderId}`);
    }
    if (platformFee > 0n) {
      await this.chain.transfer('escrow', this.chain.walletAddress('buyback'), platformFee, `release-buyback:${orderId}`);
    }
  }

  async refund(orderId: string): Promise<void> {
    const order = await this.prisma.order.findUniqueOrThrow({
      where: { id: orderId },
      select: { amount: true, buyerId: true },
    });
    const buyerAccountId = await getOrCreateUserAccount(order.buyerId, this.prisma);
    await escrowRefund({ buyerAccountId, amount: order.amount, orderId }, this.prisma);
    await this.chain.transfer('escrow', this.chain.walletAddress('treasury'), order.amount, `refund:${orderId}`);
  }
}
