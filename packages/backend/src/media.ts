/**
 * Serving user-uploaded images as FILES instead of inlining them in JSON.
 *
 * Avatars and seller cover art are stored as base64 data URLs (no object
 * storage yet). Inlining those in list payloads is what made `/live` grow to
 * megabytes: 100 sellers × a ~150KB cover is a ~15MB response, re-fetched by
 * every viewer every 30s. The images themselves are fine — putting them in the
 * JSON was the mistake.
 *
 * So list endpoints emit a URL here, and this module serves the bytes once, with
 * caching. A browser then fetches each image at most once per TTL and reuses it
 * across every card and page, instead of re-downloading it inside every payload.
 */
import { createHash } from 'node:crypto';

/** How long a browser may reuse a cached image before revalidating. Images
 *  change rarely; a stale avatar for a few minutes is not worth the bandwidth. */
export const MEDIA_MAX_AGE_S = 300;

export interface DecodedImage {
  body: Buffer;
  contentType: string;
  etag: string;
}

/** Split a `data:image/...;base64,...` URL into servable bytes. Returns null for
 *  anything that isn't an inline image (e.g. an https URL we don't proxy). */
export function decodeDataUrl(value: string | null | undefined): DecodedImage | null {
  if (!value) return null;
  const m = /^data:(image\/(?:png|jpeg|webp|gif));base64,(.+)$/s.exec(value.trim());
  if (!m) return null;
  try {
    const body = Buffer.from(m[2]!, 'base64');
    if (body.length === 0) return null;
    // Content-addressed: the ETag changes exactly when the image does, so a
    // client revalidating an updated image gets the new bytes immediately.
    const etag = `"${createHash('sha1').update(body).digest('hex').slice(0, 16)}"`;
    return { body, contentType: m[1]!, etag };
  } catch {
    return null;
  }
}

/**
 * The URL a list payload should carry for an image.
 *
 * - A stored data URL becomes a link to our media route.
 * - An `https://` value (pump.fun art) is passed through untouched.
 * - Anything else becomes null rather than shipping junk to the client.
 *
 * `v` is a short content hash so an updated image gets a NEW url — that is what
 * lets the response itself be cached hard without ever serving a stale picture.
 */
export function mediaUrl(
  kind: 'avatar' | 'cover' | 'listing',
  id: string,
  stored: string | null | undefined,
): string | null {
  if (!stored) return null;
  const s = stored.trim();
  if (s.startsWith('https://')) return s;
  if (!s.startsWith('data:image/')) return null;
  const v = createHash('sha1').update(s).digest('hex').slice(0, 12);
  return `/media/${kind}?id=${encodeURIComponent(id)}&v=${v}`;
}
