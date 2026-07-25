/**
 * Minimal Phantom (window.solana) integration — deliberately NOT the wallet-
 * adapter stack. The only thing BIDit ever asks a wallet to do is sign the
 * coin-create transaction message our backend prepared, so we talk to the
 * injected provider directly: connect() for the pubkey, and the low-level
 * `request({ method: 'signTransaction', params: { message } })` form, which
 * signs a b58-encoded transaction message and returns the signature — no
 * @solana/web3.js in the browser, no transaction parsing client-side.
 */

interface PhantomProvider {
  isPhantom?: boolean;
  connect(opts?: { onlyIfTrusted?: boolean }): Promise<{ publicKey: { toString(): string } }>;
  disconnect?(): Promise<void>;
  request(args: { method: string; params: Record<string, unknown> }): Promise<unknown>;
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

/** Sign a b58 transaction message; returns the b58 signature + signing pubkey. */
export async function signTxMessage(messageB58: string): Promise<{ signature: string; publicKey: string }> {
  const p = provider();
  if (!p) throw new PhantomError('NOT_INSTALLED', 'Phantom is not installed.');
  try {
    const res = (await p.request({ method: 'signTransaction', params: { message: messageB58 } })) as {
      signature?: unknown;
      publicKey?: unknown;
    };
    if (typeof res?.signature !== 'string' || typeof res?.publicKey !== 'string') {
      // Some Phantom builds only support the object-form signTransaction; the
      // caller surfaces the paste fallback instead of guessing.
      throw new PhantomError('UNSUPPORTED', 'This Phantom version returned an unexpected signature format.');
    }
    return { signature: res.signature, publicKey: res.publicKey };
  } catch (err) {
    if (err instanceof PhantomError) throw err;
    if ((err as { code?: number }).code === 4001) {
      throw new PhantomError('REJECTED', 'You closed the Phantom popup — nothing was created.');
    }
    throw new PhantomError('UNSUPPORTED', (err as Error).message || 'Phantom signing failed.');
  }
}
