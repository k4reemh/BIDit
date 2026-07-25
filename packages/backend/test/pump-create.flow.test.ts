import { describe, it, expect, beforeEach } from 'vitest';
import { prisma } from '../src/db.js';
import { resetDb, makeUser } from './setup.js';
import {
  prepareCoinCreate,
  submitCoinCreate,
  getCoinCreateStatus,
  finalizeConfirmed,
} from '../src/pump-create.js';
import { MockPumpCreateProvider, PumpCreateError } from '../src/chain/pump-provider.js';
import { setSellerCoin, resolveRoomByCoin } from '../src/sellers.js';
import { submitSellerOnboarding } from '../src/authz.js';

let provider: MockPumpCreateProvider;

beforeEach(async () => {
  await resetDb();
  provider = new MockPumpCreateProvider();
});

const linkedCoinOf = async (sellerId: string) =>
  (await prisma.sellerProfile.findUnique({ where: { userId: sellerId } }))?.pumpCoinAddress ?? null;

describe('coin create — happy path', () => {
  it('prepare → submit confirms, links the mint, and resolves the room', async () => {
    const s = await makeUser('seller');
    const { attempt } = await prepareCoinCreate(s.userId, null, provider, prisma);
    expect(attempt.status).toBe('PREPARED');
    // Handle may be byte-clipped to keep the full name ≤32 bytes.
    expect(attempt.name.endsWith("'s BIDit Livestream")).toBe(true);
    expect(s.handle.startsWith(attempt.name.replace("'s BIDit Livestream", ''))).toBe(true);

    const result = await submitCoinCreate(s.userId, attempt.id, null, provider, prisma);
    expect(result.status).toBe('CONFIRMED');
    expect(result.linkedCoin).toBe(attempt.mint);
    expect(await linkedCoinOf(s.userId)).toBe(attempt.mint);
    // The coin now routes to the seller's room like any hand-pasted coin.
    expect((await resolveRoomByCoin(attempt.mint, prisma))?.room).toBe(s.userId);

    const row = await prisma.pumpCoinCreateAttempt.findUniqueOrThrow({ where: { id: attempt.id } });
    expect(row.status).toBe('CONFIRMED');
    expect(row.txSig).toBeTruthy();
  });

  it('status endpoint reflects NONE before any attempt', async () => {
    const s = await makeUser('seller');
    const dto = await getCoinCreateStatus(s.userId, provider, prisma);
    expect(dto).toMatchObject({ status: 'NONE', linkedCoin: null });
  });
});

describe('coin create — guards', () => {
  it('refuses to prepare when a coin is already linked', async () => {
    const s = await makeUser('seller');
    await setSellerCoin(s.userId, 'EXISTING_COIN', prisma);
    await expect(prepareCoinCreate(s.userId, null, provider, prisma)).rejects.toMatchObject({
      code: 'ALREADY_LINKED',
      status: 409,
    });
  });

  it('a newer prepare supersedes the old attempt; the old one cannot submit', async () => {
    const s = await makeUser('seller');
    const { attempt: a } = await prepareCoinCreate(s.userId, null, provider, prisma);
    const { attempt: b } = await prepareCoinCreate(s.userId, null, provider, prisma);

    const aRow = await prisma.pumpCoinCreateAttempt.findUniqueOrThrow({ where: { id: a.id } });
    expect(aRow.status).toBe('SUPERSEDED');

    await expect(submitCoinCreate(s.userId, a.id, null, provider, prisma)).rejects.toMatchObject({ code: 'SUPERSEDED' });
    const result = await submitCoinCreate(s.userId, b.id, null, provider, prisma);
    expect(result.status).toBe('CONFIRMED');
    expect(await linkedCoinOf(s.userId)).toBe(b.mint);
  });

  it('provider outage fails fast and leaves no attempt rows', async () => {
    const s = await makeUser('seller');
    provider.failNextPrepare();
    await expect(prepareCoinCreate(s.userId, null, provider, prisma)).rejects.toMatchObject({
      code: 'PROVIDER_UNAVAILABLE',
    });
    expect(await prisma.pumpCoinCreateAttempt.count()).toBe(0);
  });

  it('someone else’s attempt id is a 404', async () => {
    const s1 = await makeUser('seller');
    const s2 = await makeUser('seller');
    const { attempt } = await prepareCoinCreate(s1.userId, null, provider, prisma);
    await expect(submitCoinCreate(s2.userId, attempt.id, null, provider, prisma)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
});

describe('coin create — expiry and wallet mismatch', () => {
  it('an expired blockhash 410s, marks the attempt FAILED, and a fresh attempt succeeds', async () => {
    const s = await makeUser('seller');
    provider.expireNextPrepare();
    const { attempt: stale } = await prepareCoinCreate(s.userId, 'WALLET_A', provider, prisma);
    await expect(submitCoinCreate(s.userId, stale.id, null, provider, prisma)).rejects.toMatchObject({
      code: 'TX_EXPIRED',
    });
    expect((await prisma.pumpCoinCreateAttempt.findUniqueOrThrow({ where: { id: stale.id } })).status).toBe('FAILED');

    const { attempt: fresh } = await prepareCoinCreate(s.userId, 'WALLET_A', provider, prisma);
    const result = await submitCoinCreate(s.userId, fresh.id, null, provider, prisma);
    expect(result.status).toBe('CONFIRMED');
  });

  it('a signature from the wrong wallet is rejected without killing the attempt', async () => {
    const s = await makeUser('seller');
    const { attempt } = await prepareCoinCreate(s.userId, 'WALLET_A', provider, prisma);

    await expect(
      submitCoinCreate(s.userId, attempt.id, { publicKey: 'WALLET_B', signatureB58: 'sig' }, provider, prisma),
    ).rejects.toMatchObject({ code: 'WALLET_MISMATCH' });
    expect((await prisma.pumpCoinCreateAttempt.findUniqueOrThrow({ where: { id: attempt.id } })).status).toBe('PREPARED');

    // Re-signing with the right wallet still works on the SAME attempt.
    const result = await submitCoinCreate(
      s.userId,
      attempt.id,
      { publicKey: 'WALLET_A', signatureB58: 'sig' },
      provider,
      prisma,
    );
    expect(result.status).toBe('CONFIRMED');
  });
});

describe('coin create — races and ambiguity', () => {
  it('two racing submits broadcast exactly once and both land on the same outcome', async () => {
    const s = await makeUser('seller');
    const { attempt } = await prepareCoinCreate(s.userId, null, provider, prisma);
    const [r1, r2] = await Promise.all([
      submitCoinCreate(s.userId, attempt.id, null, provider, prisma),
      submitCoinCreate(s.userId, attempt.id, null, provider, prisma),
    ]);
    expect(provider.broadcasts).toBe(1);
    // Both callers converge on the confirmed state (one may briefly read SUBMITTED).
    expect(['CONFIRMED', 'SUBMITTED']).toContain(r1.status);
    expect(['CONFIRMED', 'SUBMITTED']).toContain(r2.status);
    const dto = await getCoinCreateStatus(s.userId, provider, prisma);
    expect(dto.status).toBe('CONFIRMED');
    expect(await linkedCoinOf(s.userId)).toBe(attempt.mint);
  });

  it('an ambiguous broadcast stays SUBMITTED, then the status poll finalizes it (tab-close recovery)', async () => {
    const s = await makeUser('seller');
    provider.ambiguousSubmits();
    const { attempt } = await prepareCoinCreate(s.userId, null, provider, prisma);
    const result = await submitCoinCreate(s.userId, attempt.id, null, provider, prisma);
    expect(result.status).toBe('SUBMITTED');
    expect(await linkedCoinOf(s.userId)).toBeNull(); // not linked yet

    const row = await prisma.pumpCoinCreateAttempt.findUniqueOrThrow({ where: { id: attempt.id } });
    provider.resolve(row.txSig!, 'confirmed');
    const dto = await getCoinCreateStatus(s.userId, provider, prisma);
    expect(dto.status).toBe('CONFIRMED');
    expect(await linkedCoinOf(s.userId)).toBe(attempt.mint);
  });

  it('an ambiguous broadcast that dies on-chain ends FAILED and links nothing', async () => {
    const s = await makeUser('seller');
    provider.ambiguousSubmits();
    const { attempt } = await prepareCoinCreate(s.userId, null, provider, prisma);
    await submitCoinCreate(s.userId, attempt.id, null, provider, prisma);

    const row = await prisma.pumpCoinCreateAttempt.findUniqueOrThrow({ where: { id: attempt.id } });
    provider.resolve(row.txSig!, 'failed');
    const dto = await getCoinCreateStatus(s.userId, provider, prisma);
    expect(dto.status).toBe('FAILED');
    expect(await linkedCoinOf(s.userId)).toBeNull();
  });

  it('finalize is idempotent', async () => {
    const s = await makeUser('seller');
    const { attempt } = await prepareCoinCreate(s.userId, null, provider, prisma);
    await submitCoinCreate(s.userId, attempt.id, null, provider, prisma);
    await finalizeConfirmed(attempt.id, prisma);
    await finalizeConfirmed(attempt.id, prisma);
    expect(await linkedCoinOf(s.userId)).toBe(attempt.mint);
    expect(await prisma.sellerProfile.count({ where: { pumpCoinAddress: attempt.mint } })).toBe(1);
  });

  it('a coin pasted mid-confirm wins; the confirmed create never clobbers it', async () => {
    const s = await makeUser('seller');
    provider.ambiguousSubmits();
    const { attempt } = await prepareCoinCreate(s.userId, null, provider, prisma);
    await submitCoinCreate(s.userId, attempt.id, null, provider, prisma); // SUBMITTED

    await setSellerCoin(s.userId, 'PASTED_COIN', prisma); // seller pastes in another tab

    const row = await prisma.pumpCoinCreateAttempt.findUniqueOrThrow({ where: { id: attempt.id } });
    provider.resolve(row.txSig!, 'confirmed');
    const dto = await getCoinCreateStatus(s.userId, provider, prisma);
    expect(dto.status).toBe('CONFIRMED');
    expect(dto.linkedCoin).toBe('PASTED_COIN'); // the paste stands
    expect(await linkedCoinOf(s.userId)).toBe('PASTED_COIN');
    expect(dto.error).toContain('another coin');
  });
});

describe('onboarding no longer touches the coin link', () => {
  it('submitSellerOnboarding leaves pumpCoinAddress untouched', async () => {
    const s = await makeUser('seller');
    await setSellerCoin(s.userId, 'MY_COIN', prisma);
    await submitSellerOnboarding(s.userId, { website: 'https://x.example', pitch: 'cards' }, prisma);
    expect(await linkedCoinOf(s.userId)).toBe('MY_COIN');
  });

  it('the endpoint order (guarded setSellerCoin first) blocks hijack before onboarding completes', async () => {
    const a = await makeUser('seller');
    const b = await makeUser('seller');
    await setSellerCoin(a.userId, 'SHARED_COIN', prisma);
    await setSellerCoin(b.userId, '', prisma);

    // Mirror the /seller/onboarding handler: coin first (throws), onboarding never runs.
    await expect(setSellerCoin(b.userId, 'SHARED_COIN', prisma)).rejects.toThrow();
    const profile = await prisma.sellerProfile.findUnique({ where: { userId: b.userId } });
    expect(profile?.onboardedSeller).toBe(false);
    expect((await resolveRoomByCoin('SHARED_COIN', prisma))?.room).toBe(a.userId);
  });
});

describe('DB uniqueness backstop', () => {
  it('pumpCoinAddress is DB-unique — a raw duplicate write is rejected', async () => {
    const a = await makeUser('seller');
    const b = await makeUser('seller');
    await setSellerCoin(a.userId, 'UNIQ_COIN', prisma);
    await prisma.sellerProfile.create({ data: { userId: b.userId } });
    await expect(
      prisma.sellerProfile.update({ where: { userId: b.userId }, data: { pumpCoinAddress: 'UNIQ_COIN' } }),
    ).rejects.toThrow(); // P2002
  });
});
