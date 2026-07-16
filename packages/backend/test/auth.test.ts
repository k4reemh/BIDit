import { describe, it, expect } from 'vitest';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { randomBytes } from 'node:crypto';
import {
  issueSession,
  verifySession,
  parseBearer,
  buildLoginChallenge,
  verifyWalletSignature,
  isValidWalletAddress,
  outstandingChallengeCount,
  issueWsTicket,
  consumeWsTicket,
  setRevokedEpoch,
} from '../src/auth.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const randomAddress = () => bs58.encode(randomBytes(32));

describe('session tokens', () => {
  it('round-trips a userId', () => {
    const token = issueSession('user_abc');
    expect(verifySession(token)).toBe('user_abc');
  });

  it('rejects a tampered token', () => {
    const token = issueSession('user_abc');
    const tampered = token.slice(0, -2) + (token.endsWith('aa') ? 'bb' : 'aa');
    expect(verifySession(tampered)).toBeNull();
  });

  it('rejects an expired token and garbage', () => {
    const expired = issueSession('user_abc', -1000);
    expect(verifySession(expired)).toBeNull();
    expect(verifySession('not-a-token')).toBeNull();
    expect(verifySession(null)).toBeNull();
  });

  it('parses a Bearer header', () => {
    expect(parseBearer('Bearer abc.def')).toBe('abc.def');
    expect(parseBearer('Basic xyz')).toBeNull();
    expect(parseBearer(undefined)).toBeNull();
  });
});

describe('wallet-signature login', () => {
  it('verifies a genuine ed25519 signature of the challenge', () => {
    const kp = nacl.sign.keyPair();
    const address = bs58.encode(kp.publicKey);
    const message = buildLoginChallenge(address);
    const signature = bs58.encode(nacl.sign.detached(new TextEncoder().encode(message), kp.secretKey));
    expect(verifyWalletSignature(address, signature)).toBe(true);
  });

  it('rejects a wrong signature and is single-use (nonce consumed)', () => {
    const kp = nacl.sign.keyPair();
    const address = bs58.encode(kp.publicKey);
    const message = buildLoginChallenge(address);
    const goodSig = bs58.encode(nacl.sign.detached(new TextEncoder().encode(message), kp.secretKey));

    // A signature from a different key must fail.
    const other = nacl.sign.keyPair();
    const badSig = bs58.encode(nacl.sign.detached(new TextEncoder().encode(message), other.secretKey));
    expect(verifyWalletSignature(address, badSig)).toBe(false);

    // The genuine one works once...
    expect(verifyWalletSignature(address, goodSig)).toBe(true);
    // ...but not twice (nonce consumed).
    expect(verifyWalletSignature(address, goodSig)).toBe(false);
  });

  it('rejects a wallet with no outstanding challenge', () => {
    const kp = nacl.sign.keyPair();
    const address = bs58.encode(kp.publicKey);
    const signature = bs58.encode(nacl.sign.detached(new TextEncoder().encode('x'), kp.secretKey));
    expect(verifyWalletSignature(address, signature)).toBe(false);
  });
});

describe('wallet address validation', () => {
  it('accepts a real 32-byte base58 Solana address', () => {
    expect(isValidWalletAddress(randomAddress())).toBe(true);
    expect(isValidWalletAddress(bs58.encode(nacl.sign.keyPair().publicKey))).toBe(true);
  });

  it('rejects empty, non-base58, and wrong-length input', () => {
    expect(isValidWalletAddress('')).toBe(false);
    expect(isValidWalletAddress('   ')).toBe(false);
    expect(isValidWalletAddress('not-base58-because-of-these!@#')).toBe(false);
    expect(isValidWalletAddress(bs58.encode(randomBytes(16)))).toBe(false); // 16 bytes, too short
    expect(isValidWalletAddress(bs58.encode(randomBytes(64)))).toBe(false); // 64 bytes, too long
  });
});

describe('challenge map bounding', () => {
  it('never grows past the hard cap even under a flood of distinct addresses', () => {
    for (let i = 0; i < 10_200; i++) buildLoginChallenge(randomAddress());
    expect(outstandingChallengeCount()).toBeLessThanOrEqual(10_000);
  });
});

describe('session revocation', () => {
  it('rejects a token issued before the revocation epoch, accepts one issued after', async () => {
    const uid = 'rev-' + Date.now();
    const oldTok = issueSession(uid);
    expect(verifySession(oldTok)).toBe(uid); // valid before any revocation

    await sleep(3);
    setRevokedEpoch(uid, Date.now()); // "log out everywhere" now
    expect(verifySession(oldTok)).toBeNull(); // the old token is dead

    await sleep(3);
    const newTok = issueSession(uid); // re-login → issued after the epoch
    expect(verifySession(newTok)).toBe(uid); // works again
  });

  it('does not affect other users', async () => {
    const a = 'reva-' + Date.now();
    const b = 'revb-' + Date.now();
    const tokA = issueSession(a);
    const tokB = issueSession(b);
    await sleep(3);
    setRevokedEpoch(a, Date.now()); // only A logs out
    expect(verifySession(tokA)).toBeNull();
    expect(verifySession(tokB)).toBe(b); // B untouched
  });
});

describe('WebSocket tickets', () => {
  it('mints a ticket that authenticates once and only once', () => {
    const ticket = issueWsTicket('user-123');
    expect(typeof ticket).toBe('string');
    expect(ticket.length).toBeGreaterThan(20);
    expect(consumeWsTicket(ticket)).toBe('user-123'); // valid
    expect(consumeWsTicket(ticket)).toBeNull(); // consumed — can't be replayed
  });

  it('rejects unknown, empty, or missing tickets', () => {
    expect(consumeWsTicket('nope-not-a-ticket')).toBeNull();
    expect(consumeWsTicket('')).toBeNull();
    expect(consumeWsTicket(null)).toBeNull();
    expect(consumeWsTicket(undefined)).toBeNull();
  });

  it('issues distinct tickets per call', () => {
    const a = issueWsTicket('u1');
    const b = issueWsTicket('u1');
    expect(a).not.toBe(b);
    expect(consumeWsTicket(a)).toBe('u1');
    expect(consumeWsTicket(b)).toBe('u1');
  });
});
