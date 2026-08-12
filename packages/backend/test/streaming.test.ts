import { describe, it, expect, beforeEach } from 'vitest';
import { prisma } from '../src/db.js';
import { applyAsSeller } from '../src/authz.js';
import { setSellerCoin, resolveRoomByCoin, resolveRoomByHandle } from '../src/sellers.js';
import {
  enableNativeStreaming,
  setStreamSource,
  goLiveCredentials,
  applyLiveStatus,
  streamStatusForRoom,
} from '../src/streaming.js';
import { MockStreamProvider } from '../src/streaming/provider.js';
import { resetDb, makeUser } from './setup.js';

const provider = new MockStreamProvider();
const COIN = 'So11111111111111111111111111111111111111112';

async function seller(handle = 'streamer') {
  const u = await makeUser('buyer');
  await prisma.user.update({ where: { id: u.userId }, data: { handle } });
  await applyAsSeller(u.userId, prisma);
  return u.userId;
}

beforeEach(async () => { await resetDb(); });

describe('native streaming domain', () => {
  it('enables native streaming and is idempotent', async () => {
    const id = await seller();
    const first = await enableNativeStreaming(id, provider, prisma);
    expect(first.created).toBe(true);
    expect(first.liveInputId).toBe(`li_${id}`);
    const p = await prisma.sellerProfile.findUnique({ where: { userId: id } });
    expect(p!.streamSource).toBe('native');
    expect(p!.liveInputId).toBe(`li_${id}`);
    expect(p!.streamCustomerCode).toBe('mockcf');
    // Second call reuses the same input.
    const second = await enableNativeStreaming(id, provider, prisma);
    expect(second.created).toBe(false);
    expect(second.liveInputId).toBe(first.liveInputId);
  });

  it('toggles source between native and pumpfun', async () => {
    const id = await seller();
    expect(await setStreamSource(id, 'native', provider, prisma)).toBe('native');
    expect(await setStreamSource(id, 'pumpfun', provider, prisma)).toBe('pumpfun');
    const p = await prisma.sellerProfile.findUnique({ where: { userId: id } });
    expect(p!.streamSource).toBe('pumpfun');
    expect(p!.liveInputId).toBe(`li_${id}`); // input kept, just not the active source
  });

  it('hands out owner ingest creds only when native is enabled', async () => {
    const id = await seller();
    await expect(goLiveCredentials(id, provider, prisma)).rejects.toThrow(/not enabled/);
    await enableNativeStreaming(id, provider, prisma);
    const creds = await goLiveCredentials(id, provider, prisma);
    expect(creds.rtmpsUrl).toContain('rtmps://');
    expect(creds.streamKey).toContain(`li_${id}`);
    expect(creds.whipUrl).toContain('/webRTC/publish');
  });

  it('applies live status idempotently and notifies on going live', async () => {
    const id = await seller();
    await enableNativeStreaming(id, provider, prisma);
    const on = await applyLiveStatus(`li_${id}`, true, prisma);
    expect(on).toEqual({ room: id, changed: true });
    expect((await prisma.sellerProfile.findUnique({ where: { userId: id } }))!.isLiveNow).toBe(true);
    expect(await prisma.notification.count({ where: { userId: id, kind: 'live' } })).toBe(1);
    // Same status again: no change, no duplicate notification.
    const again = await applyLiveStatus(`li_${id}`, true, prisma);
    expect(again).toEqual({ room: id, changed: false });
    expect(await prisma.notification.count({ where: { userId: id, kind: 'live' } })).toBe(1);
    // Going offline.
    const off = await applyLiveStatus(`li_${id}`, false, prisma);
    expect(off!.changed).toBe(true);
    expect((await prisma.sellerProfile.findUnique({ where: { userId: id } }))!.isLiveNow).toBe(false);
  });

  it('ignores live status for an unknown input', async () => {
    expect(await applyLiveStatus('li_nope', true, prisma)).toBeNull();
  });

  it('reports room stream status (pumpfun vs native)', async () => {
    const id = await seller();
    // default pumpfun
    let st = await streamStatusForRoom(id, prisma);
    expect(st.source).toBe('pumpfun');
    expect(st.iframeUrl).toBeNull();
    // native + live
    await enableNativeStreaming(id, provider, prisma);
    await applyLiveStatus(`li_${id}`, true, prisma);
    st = await streamStatusForRoom(id, prisma);
    expect(st.source).toBe('native');
    expect(st.live).toBe(true);
    expect(st.iframeUrl).toContain(`customer-mockcf.cloudflarestream.com/li_${id}/iframe`);
    expect(st.mock).toBe(true);
  });
});

describe('room resolution with stream source', () => {
  it('resolves a native seller by handle (no coin needed)', async () => {
    const id = await seller('nativestreamer');
    await enableNativeStreaming(id, provider, prisma);
    await applyLiveStatus(`li_${id}`, true, prisma);
    const room = await resolveRoomByHandle('@NativeStreamer', prisma); // case-insensitive + @
    expect(room).not.toBeNull();
    expect(room!.room).toBe(id);
    expect(room!.streamSource).toBe('native');
    expect(room!.isLiveNow).toBe(true);
    expect(room!.coin).toBeNull();
    expect(room!.streamIframeUrl).toContain(`li_${id}/iframe`);
  });

  it('a pumpfun seller still resolves by coin with streamSource pumpfun', async () => {
    const id = await seller('pumpseller');
    await setSellerCoin(id, COIN, prisma);
    const room = await resolveRoomByCoin(COIN, prisma);
    expect(room!.streamSource).toBe('pumpfun');
    expect(room!.coin).toBe(COIN);
    expect(room!.isLiveNow).toBe(false);
    expect(room!.streamIframeUrl).toBeNull();
  });

  it('resolveRoomByHandle returns null for a non-seller or unknown handle', async () => {
    expect(await resolveRoomByHandle('ghost', prisma)).toBeNull();
    const u = await makeUser('buyer'); // a user with no seller profile
    await prisma.user.update({ where: { id: u.userId }, data: { handle: 'justabuyer' } });
    expect(await resolveRoomByHandle('justabuyer', prisma)).toBeNull();
  });
});
