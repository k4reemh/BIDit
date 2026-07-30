/**
 * Off-chain coin create: the path that actually ships on mainnet.
 *
 * The seller proves wallet ownership by signing pump.fun's sign-in text; we
 * verify that signature ourselves before it is worth anything to anyone, then
 * create the coin through pump.fun in one call. These tests drive the real
 * domain flow with a mock provider (no network), and sign with a throwaway
 * keypair generated per test, no wallet, no chain, no secrets.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { prisma } from '../src/db.js';
import { resetDb, makeUser } from './setup.js';
import { prepareCoinCreate, submitCoinCreate, getCoinCreateStatus } from '../src/pump-create.js';
import { MockOffchainProvider, PumpCreateError, pumpLoginMessage } from '../src/chain/pump-provider.js';
import { resolveRoomByCoin } from '../src/sellers.js';

let provider: MockOffchainProvider;

beforeEach(async () => {
  await resetDb();
  provider = new MockOffchainProvider();
});

/** A stand-in for the seller's Phantom wallet. */
function wallet() {
  const kp = nacl.sign.keyPair();
  return {
    address: bs58.encode(kp.publicKey),
    sign: (msg: string) =>
      Buffer.from(nacl.sign.detached(new TextEncoder().encode(msg), kp.secretKey)).toString('base64'),
  };
}

const linkedCoinOf = async (sellerId: string) =>
  (await prisma.sellerProfile.findUnique({ where: { userId: sellerId } }))?.pumpCoinAddress ?? null;

describe('off-chain coin create', () => {
  it('sign-in signature → coin created, linked, and routable', async () => {
    const s = await makeUser('seller');
    const w = wallet();

    const prep = await prepareCoinCreate(s.userId, w.address, provider, prisma);
    expect(prep.signMode).toBe('message');
    // No mint yet: pump.fun assigns it at create time.
    expect(prep.attempt.mint).toBeNull();
    expect(prep.loginMessage).toBe(pumpLoginMessage(prep.attempt.loginTimestamp!));

    const result = await submitCoinCreate(
      s.userId,
      prep.attempt.id,
      { publicKey: w.address, signatureB64: w.sign(prep.loginMessage!) },
      provider,
      prisma,
    );

    expect(result.status).toBe('CONFIRMED');
    expect(result.mint).toBeTruthy();
    expect(await linkedCoinOf(s.userId)).toBe(result.mint);
    expect((await resolveRoomByCoin(result.mint!, prisma))?.room).toBe(s.userId);
    // No transaction was ever built or broadcast.
    expect(result.txSig).toBeNull();
  });

  it('never stores the sign-in signature: it is a session credential', async () => {
    const s = await makeUser('seller');
    const w = wallet();
    const prep = await prepareCoinCreate(s.userId, w.address, provider, prisma);
    const signature = w.sign(prep.loginMessage!);
    await submitCoinCreate(s.userId, prep.attempt.id, { publicKey: w.address, signatureB64: signature }, provider, prisma);

    const row = await prisma.pumpCoinCreateAttempt.findUniqueOrThrow({ where: { id: prep.attempt.id } });
    const serialized = JSON.stringify(row, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
    expect(serialized).not.toContain(signature);
  });

  it('rejects a signature that does not verify, without touching pump.fun', async () => {
    const s = await makeUser('seller');
    const w = wallet();
    const prep = await prepareCoinCreate(s.userId, w.address, provider, prisma);

    // Right wallet, wrong message.
    const wrong = w.sign(pumpLoginMessage(1n));
    await expect(
      submitCoinCreate(s.userId, prep.attempt.id, { publicKey: w.address, signatureB64: wrong }, provider, prisma),
    ).rejects.toMatchObject({ code: 'BAD_SIGNATURE' });
    expect(provider.creates).toBe(0);

    // Non-destructive: the attempt is still signable with a good signature.
    const ok = await submitCoinCreate(
      s.userId,
      prep.attempt.id,
      { publicKey: w.address, signatureB64: w.sign(prep.loginMessage!) },
      provider,
      prisma,
    );
    expect(ok.status).toBe('CONFIRMED');
  });

  it('rejects a valid signature from a different wallet', async () => {
    const s = await makeUser('seller');
    const mine = wallet();
    const other = wallet();
    const prep = await prepareCoinCreate(s.userId, mine.address, provider, prisma);

    await expect(
      submitCoinCreate(
        s.userId,
        prep.attempt.id,
        { publicKey: other.address, signatureB64: other.sign(prep.loginMessage!) },
        provider,
        prisma,
      ),
    ).rejects.toMatchObject({ code: 'WALLET_MISMATCH' });
    expect(provider.creates).toBe(0);
    expect(await linkedCoinOf(s.userId)).toBeNull();
  });

  it('expires a stale sign-in message so the client re-prepares', async () => {
    const s = await makeUser('seller');
    const w = wallet();
    const prep = await prepareCoinCreate(s.userId, w.address, provider, prisma);

    // Age the attempt past the sign-in TTL.
    const stale = BigInt(Date.now() - 10 * 60_000);
    await prisma.pumpCoinCreateAttempt.update({
      where: { id: prep.attempt.id },
      data: { loginTimestamp: stale },
    });

    await expect(
      submitCoinCreate(
        s.userId,
        prep.attempt.id,
        { publicKey: w.address, signatureB64: w.sign(pumpLoginMessage(stale)) },
        provider,
        prisma,
      ),
    ).rejects.toMatchObject({ code: 'TX_EXPIRED' });
    expect(provider.creates).toBe(0);
    const row = await prisma.pumpCoinCreateAttempt.findUniqueOrThrow({ where: { id: prep.attempt.id } });
    expect(row.status).toBe('FAILED');
  });

  it('a pump.fun failure leaves the seller unlinked and able to retry', async () => {
    const s = await makeUser('seller');
    const w = wallet();
    const prep = await prepareCoinCreate(s.userId, w.address, provider, prisma);
    provider.failNextComplete('pump.fun is rate-limiting new coins right now: try again in a few minutes.');

    await expect(
      submitCoinCreate(
        s.userId,
        prep.attempt.id,
        { publicKey: w.address, signatureB64: w.sign(prep.loginMessage!) },
        provider,
        prisma,
      ),
    ).rejects.toMatchObject({ code: 'CREATE_FAILED' });
    expect(await linkedCoinOf(s.userId)).toBeNull();

    const dead = await prisma.pumpCoinCreateAttempt.findUniqueOrThrow({ where: { id: prep.attempt.id } });
    expect(dead.status).toBe('FAILED');
    expect(dead.lastError).toContain('rate-limiting');

    // A fresh attempt works: the failure superseded nothing permanent.
    const retry = await prepareCoinCreate(s.userId, w.address, provider, prisma);
    const ok = await submitCoinCreate(
      s.userId,
      retry.attempt.id,
      { publicKey: w.address, signatureB64: w.sign(retry.loginMessage!) },
      provider,
      prisma,
    );
    expect(ok.status).toBe('CONFIRMED');
    expect(await linkedCoinOf(s.userId)).toBe(ok.mint);
  });

  it('racing submits create exactly one coin', async () => {
    const s = await makeUser('seller');
    const w = wallet();
    const prep = await prepareCoinCreate(s.userId, w.address, provider, prisma);
    const proof = { publicKey: w.address, signatureB64: w.sign(prep.loginMessage!) };

    const results = await Promise.allSettled([
      submitCoinCreate(s.userId, prep.attempt.id, proof, provider, prisma),
      submitCoinCreate(s.userId, prep.attempt.id, proof, provider, prisma),
      submitCoinCreate(s.userId, prep.attempt.id, proof, provider, prisma),
    ]);

    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
    expect(provider.creates).toBe(1);
    expect(await prisma.pumpCoinCreateAttempt.count({ where: { sellerId: s.userId, status: 'CONFIRMED' } })).toBe(1);
  });

  it('an interrupted create is marked dead by the status poll, not left spinning', async () => {
    const s = await makeUser('seller');
    const w = wallet();
    const prep = await prepareCoinCreate(s.userId, w.address, provider, prisma);

    // Simulate a process death between the claim and pump.fun's answer.
    await prisma.pumpCoinCreateAttempt.update({
      where: { id: prep.attempt.id },
      data: { status: 'SUBMITTED', updatedAt: new Date(Date.now() - 5 * 60_000) },
    });

    const dto = await getCoinCreateStatus(s.userId, provider, prisma);
    expect(dto.status).toBe('FAILED');
    expect(dto.error).toContain('pump.fun profile');
  });

  it('will not create a second coin for a seller who already has one', async () => {
    const s = await makeUser('seller');
    const w = wallet();
    const first = await prepareCoinCreate(s.userId, w.address, provider, prisma);
    await submitCoinCreate(
      s.userId,
      first.attempt.id,
      { publicKey: w.address, signatureB64: w.sign(first.loginMessage!) },
      provider,
      prisma,
    );

    await expect(prepareCoinCreate(s.userId, w.address, provider, prisma)).rejects.toBeInstanceOf(PumpCreateError);
    expect(provider.creates).toBe(1);
  });
});
