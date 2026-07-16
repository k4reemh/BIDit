/**
 * Application-layer encryption for stored PII (shipping addresses). Defence-in-
 * depth over the database's at-rest disk encryption: a leaked DB dump is useless
 * without BIDIT_PII_KEY. AES-256-GCM.
 *
 * Values are stored as a tagged base64 string ("encv1:..."). Anything that isn't
 * tagged — legacy plaintext written before encryption was enabled, or null —
 * passes through unchanged, so this can be turned on WITHOUT a migration (old rows
 * keep working; new writes get encrypted). Keep BIDIT_PII_KEY safe and stable:
 * once data is encrypted, removing the key makes it unreadable (fails closed).
 */
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';

const PREFIX = 'encv1:';
const MIN_KEY_LEN = 16;

// Derive the AES key from BIDIT_PII_KEY, memoised per env value (scrypt is slow;
// re-derives automatically if the env changes, e.g. between tests).
let cache: { raw: string | undefined; key: Buffer | null } | null = null;
function key(): Buffer | null {
  const raw = process.env.BIDIT_PII_KEY;
  if (cache && cache.raw === raw) return cache.key;
  const k = !raw || raw.trim().length < MIN_KEY_LEN ? null : scryptSync(raw, 'bidit-pii-v1', 32);
  cache = { raw, key: k };
  return k;
}

/** True when a usable PII key is configured (so encryption is actually happening). */
export function piiEncryptionEnabled(): boolean {
  return key() !== null;
}

/** Encrypt a JSON value for storage. Returns a tagged string, or the value
 *  unchanged when no key is set or the value is null/undefined. */
export function encryptPii<T>(value: T): T | string {
  if (value === null || value === undefined) return value;
  const k = key();
  if (!k) return value; // passthrough when unconfigured
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', k, iv);
  const enc = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(value), 'utf8')), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + Buffer.concat([iv, tag, enc]).toString('base64');
}

/** Decrypt a stored value. Tagged strings are decrypted; legacy plaintext / null
 *  pass through. An encrypted value with no key (or a tampered one) returns null. */
export function decryptPii<T = unknown>(value: unknown): T | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || !value.startsWith(PREFIX)) return value as T; // legacy plaintext
  const k = key();
  if (!k) return null; // encrypted but unreadable — fail closed
  try {
    const buf = Buffer.from(value.slice(PREFIX.length), 'base64');
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const enc = buf.subarray(28);
    const decipher = createDecipheriv('aes-256-gcm', k, iv);
    decipher.setAuthTag(tag);
    const dec = Buffer.concat([decipher.update(enc), decipher.final()]);
    return JSON.parse(dec.toString('utf8')) as T;
  } catch {
    return null;
  }
}
