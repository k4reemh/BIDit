# Native streaming (BIDit-hosted, Cloudflare Stream Live)

Sellers can host their stream on BIDit instead of embedding pump.fun. They go
live from their phone (WebRTC) or OBS (RTMP); BIDit plays it back on the watch
page, and auctions run exactly as before. The auction/bid/chat system is
untouched — it keys on the seller's room (their userId), not the video.

## How it works

- `SellerProfile.streamSource` is `pumpfun` (default) or `native`.
- Enabling native provisions a Cloudflare **live input** per seller
  (`liveInputId` + `streamCustomerCode` persisted; the RTMP key / WHIP URL are
  never stored, only fetched on demand and shown to the owner).
- Going live flips `isLiveNow`, driven by Cloudflare's connect/disconnect
  **webhook** (`POST /stream/webhook`, HMAC-verified) with a 30s poller fallback.
- The watch page reaches a native seller at `/live/@<handle>` (no coin needed),
  resolves via `GET /resolve?handle=`, and polls `GET /stream/status?room=` to
  notice go-live, then plays the video (see Latency below).

## Latency

Lowest latency comes from keeping the whole path on **WebRTC**:

- **Ingest:** the one-click browser "Go Live" publishes over **WHIP** (WebRTC) —
  sub-second in. OBS/RTMPS adds a couple of seconds. No dashboard toggle needed;
  every Cloudflare live input accepts WHIP.
- **Playback:** the watch player tries **WHEP** (WebRTC playback) first for
  sub-second, glass-to-glass latency, and falls back to the Cloudflare iframe
  player (low-latency HLS, a few seconds) if WebRTC can't connect. Again, no
  toggle — WHEP is available on every live input.

So: seller uses the browser "Go Live" (not OBS) + viewers on WHEP = the lowest
latency Cloudflare offers. Nothing extra to enable in the dashboard for this.

Provider seam: `src/streaming/provider.ts` (`MockStreamProvider` for dev/tests) +
`src/streaming/cloudflare.ts` (`CloudflareStreamProvider`). Factory
`getStreamProvider()` picks Cloudflare when configured, else mock.

## Env (set in the Render dashboard — not render.yaml)

| Var | Purpose |
|---|---|
| `CLOUDFLARE_ACCOUNT_ID` | Your Cloudflare account id. |
| `CLOUDFLARE_STREAM_TOKEN` | API token with **Stream:Edit**. Read from env, never logged. |
| `CLOUDFLARE_STREAM_WEBHOOK_SECRET` | The secret Cloudflare returns when you register the webhook; verifies incoming events. |
| `BIDIT_STREAM_PROVIDER` | Optional override: `mock` or `cloudflare`. |

With none set, the provider is the mock and, in production, native streaming is
hidden from sellers (`/health` → `nativeStreaming:false`) so nobody goes "live"
on a stream that plays nothing. Non-prod builds expose the mock for testing.

## One-time Cloudflare setup

1. Enable **Stream** on your Cloudflare account.
2. Create an API token scoped to **Stream:Edit**; put it in `CLOUDFLARE_STREAM_TOKEN`
   and your account id in `CLOUDFLARE_ACCOUNT_ID`.
3. Register the webhook so live status updates instantly:
   `PUT https://api.cloudflare.com/client/v4/accounts/{account_id}/stream/webhook`
   with `{ "notificationUrl": "https://bidit-backend-fekn.onrender.com/stream/webhook" }`.
   Store the returned `secret` in `CLOUDFLARE_STREAM_WEBHOOK_SECRET`.

## Validation (Kareem — I cannot hit real Cloudflare from here)

The mock covers the whole enable → go-live → watch → bid flow in dev. On the real
provider, confirm once:

1. As a seller, enable native streaming, then broadcast — either paste the RTMP
   URL + key into OBS, or use the one-click browser "Go Live" (WHIP).
2. Open `/live/@<yourhandle>` in another browser: the stream should appear and
   show the LIVE badge. Confirm the WHEP player connects (sub-second); if it
   can't, it silently falls back to the iframe — check the browser console.
3. Cloudflare webhook flips `isLiveNow` (check `/stream/status?room=<sellerId>`),
   with the 30s poller as a backup.
4. Run an auction and place a bid — unchanged from the pump.fun path.
5. Cost check: Cloudflare Stream Live bills ~$1 per 1,000 delivered minutes plus
   a small storage line; watch the dashboard on your first real streams.

Notes / spike items:
- The webhook JSON field names (`uid` / `notificationName` / `status.state`) are
  parsed leniently; confirm against a real Cloudflare event and tighten if needed.
- Playback prefers the WHEP/WebRTC player (sub-second) and falls back to the
  Cloudflare iframe (low-latency HLS). The WHEP path only exercises against real
  Cloudflare — the mock provider renders a placeholder — so verify it in step 2.
