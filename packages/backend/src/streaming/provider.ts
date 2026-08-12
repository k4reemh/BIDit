/**
 * Native livestreaming provider seam. BIDit hosts a seller's stream itself
 * (instead of embedding pump.fun) via a managed live API. The default provider
 * is Cloudflare Stream Live; a deterministic MockStreamProvider stands in for
 * local dev and tests, so the whole go-live -> watch -> bid flow works with no
 * account or network. Same shape as the pump-create provider seam.
 *
 * SECRETS: the RTMP stream key and WHIP publish URL let anyone broadcast to a
 * seller's input, so they are treated as secrets: never persisted, never logged,
 * fetched on demand and returned only to the owning seller.
 */

/** A seller's Cloudflare live input, as we persist it (no secrets). */
export interface LiveInput {
  liveInputId: string;
  /** Cloudflare account "customer subdomain" code, for building playback URLs. */
  customerCode: string;
}

/** Playback URLs for a live input (no secrets): safe to hand any viewer. */
export interface Playback {
  /** Cloudflare Stream iframe player (handles low-latency HLS + controls). */
  iframeUrl: string;
  /** Raw LL-HLS manifest, for a custom player. */
  hlsUrl: string;
}

/** Deterministic Cloudflare playback URLs from an input id + customer code. Pure
 *  string formatting (no secrets, no network), so resolvers can build viewer URLs
 *  without holding a provider instance. */
export function nativePlaybackUrls(liveInputId: string, customerCode: string): Playback {
  const base = `https://customer-${customerCode}.cloudflarestream.com/${liveInputId}`;
  return { iframeUrl: `${base}/iframe`, hlsUrl: `${base}/manifest/video.m3u8` };
}

/** The (secret) broadcast credentials for an input. Owner-only. */
export interface IngestCreds {
  /** OBS / RTMP ingest. */
  rtmpsUrl: string;
  streamKey: string;
  /** One-click browser broadcast (WebRTC / WHIP) — publish a webcam with no OBS. */
  whipUrl: string;
}

export interface StreamWebhookEvent {
  liveInputId: string;
  live: boolean;
}

export interface StreamProvider {
  readonly mode: 'mock' | 'cloudflare';
  /** Create a fresh live input for a seller. Called once when they enable native
   *  streaming; the caller persists the result and reuses it thereafter. */
  createLiveInput(sellerId: string, name: string): Promise<LiveInput>;
  /** Secret broadcast creds for an input (RTMP key + WHIP). Owner-only. */
  getIngest(liveInputId: string): Promise<IngestCreds>;
  /** Whether an input is currently receiving a broadcast. */
  getStatus(liveInputId: string): Promise<{ live: boolean }>;
  /** Playback URLs for the watch page (no secrets). */
  playback(input: LiveInput): Playback;
  /** Verify + parse a provider webhook. Returns the event, or null if the
   *  signature/body is invalid (so a forged "you're live" can't flip status). */
  verifyWebhook(headers: Record<string, string | undefined>, rawBody: string): StreamWebhookEvent | null;
}

// ---------------------------------------------------------------------------
// Mock: deterministic, in-memory, no network. Live status is a settable knob so
// tests + the dev "go live" button can drive the full flow.
// ---------------------------------------------------------------------------
export class MockStreamProvider implements StreamProvider {
  readonly mode = 'mock' as const;
  private readonly liveSet = new Set<string>();

  async createLiveInput(sellerId: string, _name: string): Promise<LiveInput> {
    return { liveInputId: `li_${sellerId}`, customerCode: 'mockcf' };
  }

  async getIngest(liveInputId: string): Promise<IngestCreds> {
    return {
      rtmpsUrl: 'rtmps://live.cloudflare.com:443/live/',
      streamKey: `mockkey_${liveInputId}`,
      whipUrl: `https://customer-mockcf.cloudflarestream.com/${liveInputId}/webRTC/publish`,
    };
  }

  async getStatus(liveInputId: string): Promise<{ live: boolean }> {
    return { live: this.liveSet.has(liveInputId) };
  }

  playback(input: LiveInput): Playback {
    // No real stream exists on mock; the web renders a "live preview" placeholder
    // when the customer code is the mock one, so the go-live wiring is verifiable.
    return nativePlaybackUrls(input.liveInputId, input.customerCode);
  }

  verifyWebhook(headers: Record<string, string | undefined>, rawBody: string): StreamWebhookEvent | null {
    // Dev/test: trust a body of { liveInputId, live } (no signature on mock).
    try {
      const b = JSON.parse(rawBody) as { liveInputId?: string; live?: boolean };
      if (typeof b.liveInputId !== 'string') return null;
      return { liveInputId: b.liveInputId, live: !!b.live };
    } catch {
      return null;
    }
  }

  // ---- test / dev knobs ----
  setLive(liveInputId: string, live: boolean): void {
    if (live) this.liveSet.add(liveInputId);
    else this.liveSet.delete(liveInputId);
  }
}

/**
 * Pick the provider. Cloudflare when both CLOUDFLARE_ACCOUNT_ID and
 * CLOUDFLARE_STREAM_TOKEN are set (and not forced to mock); mock otherwise.
 * Async so the real provider can be dynamically imported (keeps its deps out of
 * the test/mock path), mirroring getChainClient.
 */
export async function getStreamProvider(): Promise<StreamProvider> {
  const forced = (process.env.BIDIT_STREAM_PROVIDER ?? '').trim().toLowerCase();
  if (forced === 'mock') return new MockStreamProvider();
  const hasCf = !!process.env.CLOUDFLARE_ACCOUNT_ID && !!process.env.CLOUDFLARE_STREAM_TOKEN;
  if (forced === 'cloudflare' || hasCf) {
    const { CloudflareStreamProvider } = await import('./cloudflare.js');
    return new CloudflareStreamProvider();
  }
  return new MockStreamProvider();
}
