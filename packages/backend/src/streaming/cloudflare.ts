/**
 * Cloudflare Stream Live provider. Creates a live input per seller, hands back
 * RTMP + WHIP ingest for going live, reports live status, and verifies the
 * connect/disconnect webhook. Configured with CLOUDFLARE_ACCOUNT_ID +
 * CLOUDFLARE_STREAM_TOKEN (an API token with Stream:Edit); the webhook secret is
 * CLOUDFLARE_STREAM_WEBHOOK_SECRET.
 *
 * NOTE: exercised against real Cloudflare via the runbook (docs/NATIVE-STREAMING.md),
 * not the in-process test suite (which uses the mock). The token is read from env
 * and never logged.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { nativePlaybackUrls, type IngestCreds, type LiveInput, type Playback, type StreamProvider, type StreamWebhookEvent } from './provider.js';

const API = 'https://api.cloudflare.com/client/v4';
const TIMEOUT_MS = 8000;

interface CfLiveInput {
  uid: string;
  rtmps?: { url?: string; streamKey?: string };
  webRTC?: { url?: string };
  webRTCPlayback?: { url?: string };
  status?: { current?: { state?: string } };
}

/** Pull the "customer-XXXX" subdomain code out of any returned Cloudflare URL. */
function customerCodeFrom(input: CfLiveInput): string {
  const url = input.webRTCPlayback?.url ?? input.webRTC?.url ?? '';
  const m = /customer-([a-z0-9]+)\.cloudflarestream\.com/i.exec(url);
  return m?.[1] ?? '';
}

export class CloudflareStreamProvider implements StreamProvider {
  readonly mode = 'cloudflare' as const;
  private readonly accountId: string;
  private readonly token: string;
  private readonly webhookSecret: string;

  constructor() {
    this.accountId = (process.env.CLOUDFLARE_ACCOUNT_ID ?? '').trim();
    this.token = (process.env.CLOUDFLARE_STREAM_TOKEN ?? '').trim();
    this.webhookSecret = (process.env.CLOUDFLARE_STREAM_WEBHOOK_SECRET ?? '').trim();
    if (!this.accountId || !this.token) throw new Error('Cloudflare Stream: CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_STREAM_TOKEN are required');
  }

  private async cf<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(`${API}/accounts/${this.accountId}/stream${path}`, {
      ...init,
      headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json', ...(init?.headers ?? {}) },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const body = (await res.json().catch(() => null)) as { success?: boolean; result?: T; errors?: unknown } | null;
    if (!res.ok || !body?.success) {
      // Do not include the token; Cloudflare error messages are safe to surface.
      throw new Error(`Cloudflare Stream ${path} -> ${res.status} ${JSON.stringify(body?.errors ?? '')}`.slice(0, 300));
    }
    return body.result as T;
  }

  async createLiveInput(sellerId: string, name: string): Promise<LiveInput> {
    const result = await this.cf<CfLiveInput>('/live_inputs', {
      method: 'POST',
      body: JSON.stringify({
        meta: { name, biditSeller: sellerId },
        recording: { mode: 'off' },
        // Low-latency HLS so bidding stays close to real time.
        defaultCreator: sellerId,
      }),
    });
    return { liveInputId: result.uid, customerCode: customerCodeFrom(result) };
  }

  async getIngest(liveInputId: string): Promise<IngestCreds> {
    const result = await this.cf<CfLiveInput>(`/live_inputs/${liveInputId}`);
    const streamKey = result.rtmps?.streamKey ?? '';
    const rtmpsUrl = result.rtmps?.url ?? 'rtmps://live.cloudflare.com:443/live/';
    const whipUrl = result.webRTC?.url ?? '';
    return { rtmpsUrl, streamKey, whipUrl };
  }

  async getStatus(liveInputId: string): Promise<{ live: boolean }> {
    const result = await this.cf<CfLiveInput>(`/live_inputs/${liveInputId}`);
    return { live: result.status?.current?.state === 'connected' };
  }

  playback(input: LiveInput): Playback {
    return nativePlaybackUrls(input.liveInputId, input.customerCode);
  }

  verifyWebhook(headers: Record<string, string | undefined>, rawBody: string): StreamWebhookEvent | null {
    // Cloudflare signs with Webhook-Signature: "time=<ts>,sig1=<hex>", where the
    // signed payload is `<time>.<body>` HMAC-SHA256 with the webhook secret.
    const header = headers['webhook-signature'] ?? headers['Webhook-Signature'];
    if (!header || !this.webhookSecret) return null;
    const parts = Object.fromEntries(header.split(',').map((kv) => kv.split('=') as [string, string]));
    const time = parts['time'];
    const sig = parts['sig1'];
    if (!time || !sig) return null;
    const expected = createHmac('sha256', this.webhookSecret).update(`${time}.${rawBody}`).digest('hex');
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    try {
      // Live-input webhooks carry the input uid and a connect/disconnect signal.
      const body = JSON.parse(rawBody) as { uid?: string; live_input?: string; notificationName?: string; status?: { state?: string } };
      const liveInputId = body.uid ?? body.live_input ?? '';
      if (!liveInputId) return null;
      const name = (body.notificationName ?? '').toLowerCase();
      const state = (body.status?.state ?? '').toLowerCase();
      const live = name.includes('connected') && !name.includes('disconnected') ? true
        : name.includes('disconnected') ? false
        : state === 'connected';
      return { liveInputId, live };
    } catch {
      return null;
    }
  }
}
