/**
 * Native streaming domain: turn a seller's video source between pump.fun and
 * BIDit-hosted (Cloudflare Stream Live), hand out go-live credentials, and track
 * live status. The auction/bid/chat system is untouched by any of this: it keys
 * on the seller's room (their userId), not the video.
 */
import { prisma as defaultPrisma } from './db.js';
import type { PrismaClient } from './db.js';
import { notify } from './notifications.js';
import { nativePlaybackUrls, type IngestCreds, type StreamProvider } from './streaming/provider.js';

export type StreamSource = 'pumpfun' | 'native';
export const STREAM_SOURCES: StreamSource[] = ['pumpfun', 'native'];
export const asStreamSource = (s: unknown): StreamSource => (s === 'native' ? 'native' : 'pumpfun');

export interface EnableResult {
  liveInputId: string;
  customerCode: string;
  created: boolean;
}

/**
 * Turn on native streaming for a seller: ensure a Cloudflare live input exists,
 * persist it, and set their source to native. Idempotent — reuses the existing
 * input, so a seller keeps the same ingest key/URL across sessions.
 */
export async function enableNativeStreaming(
  sellerId: string,
  provider: StreamProvider,
  prisma: PrismaClient = defaultPrisma,
): Promise<EnableResult> {
  const profile = await prisma.sellerProfile.findUnique({ where: { userId: sellerId } });
  if (!profile) throw new Error('not a seller');
  let liveInputId = profile.liveInputId;
  let customerCode = profile.streamCustomerCode;
  let created = false;
  if (!liveInputId || !customerCode) {
    const input = await provider.createLiveInput(sellerId, `${sellerId} on BIDit`);
    liveInputId = input.liveInputId;
    customerCode = input.customerCode;
    created = true;
  }
  await prisma.sellerProfile.update({
    where: { userId: sellerId },
    data: { streamSource: 'native', liveInputId, streamCustomerCode: customerCode },
  });
  return { liveInputId, customerCode: customerCode ?? '', created };
}

/** Switch a seller between pump.fun and native video. Native ensures an input. */
export async function setStreamSource(
  sellerId: string,
  source: string,
  provider: StreamProvider,
  prisma: PrismaClient = defaultPrisma,
): Promise<StreamSource> {
  if (asStreamSource(source) === 'native') {
    await enableNativeStreaming(sellerId, provider, prisma);
    return 'native';
  }
  await prisma.sellerProfile.update({ where: { userId: sellerId }, data: { streamSource: 'pumpfun' } });
  return 'pumpfun';
}

/** Owner-only broadcast credentials (RTMP key + WHIP URL). Never cached/persisted. */
export async function goLiveCredentials(
  sellerId: string,
  provider: StreamProvider,
  prisma: PrismaClient = defaultPrisma,
): Promise<IngestCreds> {
  const profile = await prisma.sellerProfile.findUnique({ where: { userId: sellerId } });
  if (!profile?.liveInputId) throw new Error('native streaming not enabled');
  return provider.getIngest(profile.liveInputId);
}

/**
 * Apply a live-status change (from the Cloudflare webhook or the poller). Returns
 * the affected seller's room + whether it actually changed, so the caller can push
 * a realtime nudge only on real transitions. Notifies the seller on going live.
 */
export async function applyLiveStatus(
  liveInputId: string,
  live: boolean,
  prisma: PrismaClient = defaultPrisma,
): Promise<{ room: string; changed: boolean } | null> {
  const profile = await prisma.sellerProfile.findUnique({ where: { liveInputId } });
  if (!profile) return null;
  if (profile.isLiveNow === live) return { room: profile.userId, changed: false };
  await prisma.sellerProfile.update({
    where: { liveInputId },
    data: { isLiveNow: live, liveStartedAt: live ? new Date() : profile.liveStartedAt },
  });
  if (live) {
    await notify(
      { userId: profile.userId, kind: 'live', title: 'You are live on BIDit', body: 'Your stream is up. Start an auction whenever you are ready.', href: '/seller' },
      prisma,
    ).catch(() => {});
  }
  return { room: profile.userId, changed: true };
}

export interface RoomStreamStatus {
  source: StreamSource;
  live: boolean;
  iframeUrl: string | null;
  hlsUrl: string | null;
  /** True on the mock provider: the web shows a live placeholder instead of a
   *  broken iframe (no real Cloudflare stream exists in dev/tests). */
  mock: boolean;
}

/**
 * Poll every native seller's live status and reconcile it. Belt-and-suspenders
 * behind the webhook: catches a missed connect/disconnect. Returns how many
 * changed; `onChange(room, live)` fires per real transition. Never throws per
 * seller (a transient Cloudflare error just retries next tick).
 */
export async function pollLiveStatuses(
  provider: StreamProvider,
  prisma: PrismaClient = defaultPrisma,
  onChange?: (room: string, live: boolean) => void,
): Promise<number> {
  const natives = await prisma.sellerProfile.findMany({
    where: { streamSource: 'native', liveInputId: { not: null } },
    select: { liveInputId: true, isLiveNow: true },
  });
  let changed = 0;
  for (const s of natives) {
    try {
      const { live } = await provider.getStatus(s.liveInputId!);
      if (live === s.isLiveNow) continue;
      const r = await applyLiveStatus(s.liveInputId!, live, prisma);
      if (r?.changed) {
        changed += 1;
        onChange?.(r.room, live);
      }
    } catch {
      /* transient: retry next tick */
    }
  }
  return changed;
}

/** Watch-page video status for a room (seller userId): source, native-live, URLs. */
export async function streamStatusForRoom(
  room: string,
  prisma: PrismaClient = defaultPrisma,
): Promise<RoomStreamStatus> {
  const profile = await prisma.sellerProfile.findUnique({ where: { userId: room } });
  const source = asStreamSource(profile?.streamSource);
  if (source !== 'native' || !profile?.liveInputId || !profile.streamCustomerCode) {
    return { source, live: false, iframeUrl: null, hlsUrl: null, mock: false };
  }
  const pb = nativePlaybackUrls(profile.liveInputId, profile.streamCustomerCode);
  return {
    source,
    live: profile.isLiveNow,
    iframeUrl: pb.iframeUrl,
    hlsUrl: pb.hlsUrl,
    mock: profile.streamCustomerCode === 'mockcf',
  };
}
