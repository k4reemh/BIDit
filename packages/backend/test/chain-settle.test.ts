import { describe, it, expect, beforeEach } from 'vitest';
import { prisma } from '../src/db.js';
import { MockChain } from '../src/chain/mock.js';
import { ChainSettler } from '../src/chain-settle.js';
import { usdc } from '@bidit/shared';
import { resetDb } from './setup.js';

beforeEach(async () => { await resetDb(); });

const enqueue = (key: string, from: string, to: string, amount: bigint) =>
  prisma.chainTransfer.create({ data: { key, fromWallet: from, toWallet: to, amount, memo: key } });
const row = (key: string) => prisma.chainTransfer.findUniqueOrThrow({ where: { key } });

describe('ChainSettler — durable internal transfer outbox', () => {
  it('confirms a leg and moves the funds', async () => {
    const chain = new MockChain();
    await enqueue('lock:o1', 'treasury', 'escrow', usdc('20'));
    expect(await new ChainSettler(chain, prisma).tick()).toBe(1);
    expect((await row('lock:o1')).status).toBe('CONFIRMED');
    expect(await chain.balance('escrow')).toBe(usdc('20'));
  });

  it('an ambiguous send is not moved until it confirms — and never double-moves', async () => {
    const chain = new MockChain();
    chain.ambiguousNextSend();
    await enqueue('lock:o2', 'treasury', 'escrow', usdc('20'));
    const settler = new ChainSettler(chain, prisma);

    await settler.tick();
    const submitted = await row('lock:o2');
    expect(submitted.status).toBe('SUBMITTED');
    expect(submitted.txSig).toBeTruthy();
    expect(await chain.balance('escrow')).toBe(0n); // in flight, not moved

    // The tx actually lands — resolve + tick → confirmed, moved exactly once.
    chain.resolveTransfer(submitted.txSig!, 'confirmed');
    expect(await settler.tick()).toBe(1);
    expect((await row('lock:o2')).status).toBe('CONFIRMED');
    expect(await chain.balance('escrow')).toBe(usdc('20')); // moved once, not twice
  });

  it('a leg the chain proves dead is retried with a fresh send (safe — funds stay ours)', async () => {
    const chain = new MockChain();
    chain.ambiguousNextSend();
    await enqueue('lock:o3', 'treasury', 'escrow', usdc('20'));
    const settler = new ChainSettler(chain, prisma);

    await settler.tick(); // SUBMITTED
    chain.resolveTransfer((await row('lock:o3')).txSig!, 'failed');
    await settler.tick(); // failed → back to PENDING
    expect((await row('lock:o3')).status).toBe('PENDING');
    expect(await chain.balance('escrow')).toBe(0n); // never landed

    // Next tick: a fresh send lands → confirmed, moved exactly once.
    expect(await settler.tick()).toBe(1);
    expect((await row('lock:o3')).status).toBe('CONFIRMED');
    expect(await chain.balance('escrow')).toBe(usdc('20'));
  });

  it('a same-wallet leg (fallback config) confirms without broadcasting', async () => {
    const chain = new MockChain();
    await enqueue('shipping:s1', 'treasury', 'treasury', usdc('5'));
    await new ChainSettler(chain, prisma).tick();
    const settled = await row('shipping:s1');
    expect(settled.status).toBe('CONFIRMED');
    expect(settled.txSig).toBeNull(); // never sent
    expect(await chain.balance('treasury')).toBe(0n); // nothing moved
  });

  it('enqueuing the same leg twice is idempotent (one row)', async () => {
    await enqueue('lock:dup', 'treasury', 'escrow', usdc('20'));
    await prisma.chainTransfer.createMany({
      data: [{ key: 'lock:dup', fromWallet: 'treasury', toWallet: 'escrow', amount: usdc('20') }],
      skipDuplicates: true,
    });
    expect(await prisma.chainTransfer.count({ where: { key: 'lock:dup' } })).toBe(1);
  });
});
