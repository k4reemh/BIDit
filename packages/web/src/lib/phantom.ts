/**
 * Minimal Phantom (window.solana) integration — deliberately NOT the wallet-
 * adapter stack. The only thing BIDit ever asks a wallet to do is sign the
 * coin-create transaction our backend prepared.
 *
 * Signing uses Phantom's standard object-form `signTransaction(tx)`, which
 * handles BOTH legacy and versioned (v0) transactions. (The older low-level
 * `request({method:'signTransaction', params:{message}})` lane chokes on v0
 * bytes — its legacy parser reads the version prefix as a signer count and
 * dies with "Reached end of buffer unexpectedly".) @solana/web3.js is loaded
 * lazily so it only ships to browsers that actually reach the signing step.
 */
import type { VersionedTransaction } from '@solana/web3.js';

interface PhantomProvider {
  isPhantom?: boolean;
  connect(opts?: { onlyIfTrusted?: boolean }): Promise<{ publicKey: { toString(): string } }>;
  disconnect?(): Promise<void>;
  signTransaction?(tx: VersionedTransaction): Promise<VersionedTransaction>;
  signMessage?(message: Uint8Array, display?: 'utf8' | 'hex'): Promise<{ signature: Uint8Array }>;
}

export type PhantomErrorCode = 'NOT_INSTALLED' | 'REJECTED' | 'UNSUPPORTED';

export class PhantomError extends Error {
  constructor(
    readonly code: PhantomErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'PhantomError';
  }
}

function provider(): PhantomProvider | null {
  const w = window as unknown as { phantom?: { solana?: PhantomProvider }; solana?: PhantomProvider };
  const p = w.phantom?.solana ?? w.solana;
  return p?.isPhantom ? p : null;
}

export const hasPhantom = (): boolean => provider() !== null;

/** Connect (prompting if needed) and return the wallet's base58 public key. */
export async function connectPhantom(): Promise<string> {
  const p = provider();
  if (!p) throw new PhantomError('NOT_INSTALLED', 'Phantom is not installed.');
  try {
    const { publicKey } = await p.connect();
    return publicKey.toString();
  } catch (err) {
    if ((err as { code?: number }).code === 4001) {
      throw new PhantomError('REJECTED', 'You closed the Phantom popup — nothing was created.');
    }
    throw new PhantomError('UNSUPPORTED', (err as Error).message || 'Phantom connection failed.');
  }
}

const b64ToBytes = (b64: string): Uint8Array => {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

const bytesToB64 = (bytes: Uint8Array): string => {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin);
};

/** Sign pump.fun's plain sign-in text, so the backend can create the coin under
 *  the seller's own pump.fun account.
 *
 *  This is a MESSAGE signature, not a transaction: Phantom shows the exact words
 *  being signed, nothing can be spent, and none of the "this dApp may be
 *  malicious" transaction-simulation warnings appear. The signature is returned
 *  base64 (keeping a base58 library out of the web bundle) and is single-use —
 *  the backend verifies it, spends it on one create, and never stores it. */
export async function signLoginMessage(message: string): Promise<string> {
  const p = provider();
  if (!p) throw new PhantomError('NOT_INSTALLED', 'Phantom is not installed.');
  if (typeof p.signMessage !== 'function') {
    throw new PhantomError('UNSUPPORTED', 'This Phantom version can’t sign here — update Phantom and try again.');
  }
  try {
    const { signature } = await p.signMessage(new TextEncoder().encode(message), 'utf8');
    return bytesToB64(signature);
  } catch (err) {
    if ((err as { code?: number }).code === 4001) {
      throw new PhantomError('REJECTED', 'You closed the Phantom popup — nothing was created.');
    }
    throw new PhantomError('UNSUPPORTED', (err as Error).message || 'Phantom signing failed.');
  }
}

/** Have Phantom sign the prepared (mint-signed) create transaction; returns the
 *  fully signed tx, base64-encoded, for the backend to verify and broadcast. */
export async function signCreateTx(txB64: string): Promise<string> {
  const p = provider();
  if (!p) throw new PhantomError('NOT_INSTALLED', 'Phantom is not installed.');
  if (typeof p.signTransaction !== 'function') {
    throw new PhantomError('UNSUPPORTED', 'This Phantom version can’t sign here — update Phantom and try again.');
  }
  const { VersionedTransaction: VTx } = await import('@solana/web3.js');
  const tx = VTx.deserialize(b64ToBytes(txB64));
  try {
    const signed = await p.signTransaction(tx);
    return bytesToB64(signed.serialize());
  } catch (err) {
    if (err instanceof PhantomError) throw err;
    if ((err as { code?: number }).code === 4001) {
      throw new PhantomError('REJECTED', 'You closed the Phantom popup — nothing was created.');
    }
    throw new PhantomError('UNSUPPORTED', (err as Error).message || 'Phantom signing failed.');
  }
}
