import { describe, it, expect, beforeEach } from 'vitest';
import { prisma } from '../src/db.js';
import { applyAsSeller } from '../src/authz.js';
import { setSellerAlert, setCategoryAlert, getAlertPrefs, notifyLive, AlertError } from '../src/alerts.js';
import { enableNativeStreaming, applyLiveStatus, applyPumpLiveStatus } from '../src/streaming.js';
import { MockStreamProvider } from '../src/streaming/provider.js';
import { resetDb, makeUser } from './setup.js';

const provider = new MockStreamProvider();

async function seller(handle: string, category?: string) {
  const u = await makeUser('buyer');
  await prisma.user.update({ where: { id: u.userId }, data: { handle } });
  await applyAsSeller(u.userId, prisma);
  if (category) await prisma.sellerProfile.update({ where: { userId: u.userId }, data: { streamCategory: category } });
  return u.userId;
}
const liveNotifs = (userId: string) => prisma.notification.count({ where: { userId, kind: 'stream-live' } });

beforeEach(async () => { await resetDb(); });

describe('go-live alerts', () => {
  it('follows and unfollows a seller', async () => {
    const s = await seller('streamer_a');
    const v = (await makeUser('buyer')).userId;
    expect(await setSellerAlert(v, s, true, prisma)).toEqual({ on: true });
    let prefs = await getAlertPrefs(v, prisma);
    expect(prefs.sellers).toEqual([{ sellerId: s, handle: 'streamer_a' }]);
    await setSellerAlert(v, s, false, prisma);
    prefs = await getAlertPrefs(v, prisma);
    expect(prefs.sellers).toEqual([]);
  });

  it('rejects following yourself or a non-seller', async () => {
    const v = (await makeUser('buyer')).userId;
    const other = (await makeUser('buyer')).userId; // not a seller
    await expect(setSellerAlert(v, v, true, prisma)).rejects.toBeInstanceOf(AlertError);
    await expect(setSellerAlert(v, other, true, prisma)).rejects.toBeInstanceOf(AlertError);
  });

  it('subscribes and unsubscribes a category', async () => {
    const v = (await makeUser('buyer')).userId;
    await setCategoryAlert(v, 'Pokémon', true, prisma);
    expect((await getAlertPrefs(v, prisma)).categories).toEqual(['Pokémon']);
    await setCategoryAlert(v, 'Pokémon', false, prisma);
    expect((await getAlertPrefs(v, prisma)).categories).toEqual([]);
  });

  it('fans out to followers and category subscribers, deduped, never the seller', async () => {
    const s = await seller('streamer_b', 'Pokémon');
    const follower = (await makeUser('buyer')).userId;
    const catSub = (await makeUser('buyer')).userId;
    const both = (await makeUser('buyer')).userId;
    await setSellerAlert(follower, s, true, prisma);
    await setCategoryAlert(catSub, 'Pokémon', true, prisma);
    await setSellerAlert(both, s, true, prisma);
    await setCategoryAlert(both, 'Pokémon', true, prisma);
    // The seller opting into their own category must not self-notify.
    await setCategoryAlert(s, 'Pokémon', true, prisma);

    const count = await notifyLive(s, prisma);
    expect(count).toBe(3);
    expect(await liveNotifs(follower)).toBe(1);
    expect(await liveNotifs(catSub)).toBe(1);
    expect(await liveNotifs(both)).toBe(1); // deduped, not 2
    expect(await liveNotifs(s)).toBe(0);
  });

  it('native go-live alerts once, and a quick flap does not re-alert', async () => {
    const s = await seller('streamer_c');
    const f = (await makeUser('buyer')).userId;
    await setSellerAlert(f, s, true, prisma);
    await enableNativeStreaming(s, provider, prisma);
    const inputId = (await prisma.sellerProfile.findUnique({ where: { userId: s } }))!.liveInputId!;

    await applyLiveStatus(inputId, true, prisma);
    expect(await liveNotifs(f)).toBe(1);
    // Flap off then on within the cooldown: no second alert.
    await applyLiveStatus(inputId, false, prisma);
    await applyLiveStatus(inputId, true, prisma);
    expect(await liveNotifs(f)).toBe(1);
  });

  it('pump go-live alerts followers without a self-ping', async () => {
    const s = await seller('streamer_d');
    await prisma.sellerProfile.update({ where: { userId: s }, data: { pumpCoinAddress: 'Coin_pump_d' } });
    const f = (await makeUser('buyer')).userId;
    await setSellerAlert(f, s, true, prisma);

    const r = await applyPumpLiveStatus(s, true, prisma);
    expect(r?.changed).toBe(true);
    expect(await liveNotifs(f)).toBe(1);
    // pump seller is already on pump.fun; no "you are live" self notification.
    expect(await prisma.notification.count({ where: { userId: s, kind: 'live' } })).toBe(0);
  });
});
