import { describe, it, expect, afterEach } from 'vitest';
import { encryptPii, decryptPii, piiEncryptionEnabled } from '../src/pii.js';

const KEY = 'a-strong-pii-key-for-tests-1234567890';
const addr = { name: 'Kareem', line1: '1 Main St', city: 'Calgary', region: 'AB', postal: 'T2P 1J9', country: 'CA' };

afterEach(() => {
  delete process.env.BIDIT_PII_KEY;
});

describe('PII encryption', () => {
  it('round-trips an address when a key is configured', () => {
    process.env.BIDIT_PII_KEY = KEY;
    expect(piiEncryptionEnabled()).toBe(true);
    const enc = encryptPii(addr);
    expect(typeof enc).toBe('string');
    expect(enc as string).toMatch(/^encv1:/); // tagged, not plaintext
    expect(enc).not.toContain('Main St'); // ciphertext hides the address
    expect(decryptPii(enc)).toEqual(addr);
  });

  it('passes through unchanged when no key is set (opt-in)', () => {
    expect(piiEncryptionEnabled()).toBe(false);
    expect(encryptPii(addr)).toEqual(addr); // stored as-is
    expect(decryptPii(addr)).toEqual(addr); // read as-is
  });

  it('treats legacy plaintext + null gracefully with a key set', () => {
    process.env.BIDIT_PII_KEY = KEY;
    expect(decryptPii(addr)).toEqual(addr); // legacy plaintext object → unchanged
    expect(decryptPii(null)).toBeNull();
    expect(encryptPii(null)).toBeNull();
    expect(encryptPii(undefined)).toBeUndefined();
  });

  it('fails closed on a tampered ciphertext', () => {
    process.env.BIDIT_PII_KEY = KEY;
    const enc = encryptPii(addr) as string;
    const tampered = enc.slice(0, -4) + 'AAAA';
    expect(decryptPii(tampered)).toBeNull(); // GCM auth-tag mismatch → null, never garbage
  });

  it('cannot read ciphertext once the key is removed (fail closed)', () => {
    process.env.BIDIT_PII_KEY = KEY;
    const enc = encryptPii(addr) as string;
    delete process.env.BIDIT_PII_KEY;
    expect(decryptPii(enc)).toBeNull();
  });
});
