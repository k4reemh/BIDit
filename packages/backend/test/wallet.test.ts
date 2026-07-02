import { describe, it, expect } from 'vitest';
import { deriveDepositAddress, deriveDepositKeypair } from '../src/wallet.js';

describe('per-user deposit wallets (derived, no stored keys)', () => {
  it('derives a deterministic base58 Solana address per user', () => {
    const a1 = deriveDepositAddress('user_abc');
    const a2 = deriveDepositAddress('user_abc');
    expect(a1).toBe(a2); // deterministic
    expect(a1).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/); // base58, solana-length
  });

  it('gives different users different addresses', () => {
    expect(deriveDepositAddress('user_a')).not.toBe(deriveDepositAddress('user_b'));
  });

  it('the keypair public key matches the derived address', () => {
    const { address, secretKey } = deriveDepositKeypair('user_xyz');
    expect(address).toBe(deriveDepositAddress('user_xyz'));
    expect(secretKey.length).toBe(64); // ed25519 secret (nacl)
  });
});
