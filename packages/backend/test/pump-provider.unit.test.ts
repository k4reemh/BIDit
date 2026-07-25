import { describe, it, expect } from 'vitest';
import {
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import bs58 from 'bs58';
import nacl from 'tweetnacl';
import { vetCreateTx, mergeCreatorSignature } from '../src/chain/pump-provider.js';

const PUMP_PROGRAM = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
const FAKE_BLOCKHASH = bs58.encode(Buffer.alloc(32, 7));

/** A create-shaped tx: fee payer = creator, one pump ix signed by creator+mint. */
function buildCreateTx(creator: Keypair, mint: Keypair, extraIx: TransactionInstruction[] = []) {
  const pumpIx = new TransactionInstruction({
    programId: PUMP_PROGRAM,
    keys: [
      { pubkey: mint.publicKey, isSigner: true, isWritable: true },
      { pubkey: creator.publicKey, isSigner: true, isWritable: true },
    ],
    data: Buffer.from([24, 30, 200, 40, 5, 28, 7, 119]), // create discriminator shape
  });
  const msg = new TransactionMessage({
    payerKey: creator.publicKey,
    recentBlockhash: FAKE_BLOCKHASH,
    instructions: [pumpIx, ...extraIx],
  }).compileToV0Message();
  return new VersionedTransaction(msg);
}

describe('vetCreateTx', () => {
  it('accepts a clean create tx', () => {
    const creator = Keypair.generate();
    const mint = Keypair.generate();
    const tx = buildCreateTx(creator, mint);
    expect(() => vetCreateTx(tx.serialize(), creator.publicKey.toBase58())).not.toThrow();
  });

  it('rejects a tx whose fee payer is not the creator', () => {
    const creator = Keypair.generate();
    const mint = Keypair.generate();
    const tx = buildCreateTx(creator, mint);
    expect(() => vetCreateTx(tx.serialize(), Keypair.generate().publicKey.toBase58())).toThrowError(
      /temporarily unavailable/,
    );
  });

  it('rejects a tx touching a non-allowlisted program', () => {
    const creator = Keypair.generate();
    const mint = Keypair.generate();
    const rogue = new TransactionInstruction({
      programId: Keypair.generate().publicKey, // unknown program
      keys: [],
      data: Buffer.alloc(0),
    });
    const tx = buildCreateTx(creator, mint, [rogue]);
    expect(() => vetCreateTx(tx.serialize(), creator.publicKey.toBase58())).toThrow();
  });

  it('rejects a smuggled second pump instruction (a buy)', () => {
    const creator = Keypair.generate();
    const mint = Keypair.generate();
    const buyIx = new TransactionInstruction({
      programId: PUMP_PROGRAM,
      keys: [{ pubkey: creator.publicKey, isSigner: true, isWritable: true }],
      data: Buffer.from([102, 6, 61, 18, 1, 218, 235, 234]),
    });
    const tx = buildCreateTx(creator, mint, [buyIx]);
    expect(() => vetCreateTx(tx.serialize(), creator.publicKey.toBase58())).toThrow();
  });

  it('allows system-program transfers (rent funding) alongside the create', () => {
    const creator = Keypair.generate();
    const mint = Keypair.generate();
    const sys = SystemProgram.transfer({ fromPubkey: creator.publicKey, toPubkey: mint.publicKey, lamports: 1 });
    const tx = buildCreateTx(creator, mint, [sys]);
    expect(() => vetCreateTx(tx.serialize(), creator.publicKey.toBase58())).not.toThrow();
  });
});

describe('mergeCreatorSignature', () => {
  function prepared(creator: Keypair, mint: Keypair) {
    const tx = buildCreateTx(creator, mint);
    tx.sign([mint]); // backend's partial-sign
    return { txB64: Buffer.from(tx.serialize()).toString('base64'), message: tx.message.serialize() };
  }

  it('merges a valid creator signature and fixes the txSig', () => {
    const creator = Keypair.generate();
    const mint = Keypair.generate();
    const { txB64, message } = prepared(creator, mint);

    const sig = nacl.sign.detached(message, creator.secretKey);
    const { raw, txSig } = mergeCreatorSignature(txB64, {
      publicKey: creator.publicKey.toBase58(),
      signatureB58: bs58.encode(sig),
    });
    // txSig is the fee payer's (creator's) signature — slot 0.
    expect(txSig).toBe(bs58.encode(sig));
    // The merged tx re-parses and carries both signatures.
    const merged = VersionedTransaction.deserialize(raw);
    expect(merged.signatures.length).toBe(2);
  });

  it('rejects a signature from the wrong key', () => {
    const creator = Keypair.generate();
    const mint = Keypair.generate();
    const { txB64, message } = prepared(creator, mint);
    const wrong = Keypair.generate();
    const sig = nacl.sign.detached(message, wrong.secretKey);
    expect(() =>
      mergeCreatorSignature(txB64, { publicKey: creator.publicKey.toBase58(), signatureB58: bs58.encode(sig) }),
    ).toThrowError(/did not verify/);
  });

  it('rejects garbage signature bytes', () => {
    const creator = Keypair.generate();
    const mint = Keypair.generate();
    const { txB64 } = prepared(creator, mint);
    expect(() =>
      mergeCreatorSignature(txB64, { publicKey: creator.publicKey.toBase58(), signatureB58: 'not-b58!!!' }),
    ).toThrow();
  });

  it('accepts the whole-signed-tx fallback lane', () => {
    const creator = Keypair.generate();
    const mint = Keypair.generate();
    const { txB64 } = prepared(creator, mint);

    const full = VersionedTransaction.deserialize(Buffer.from(txB64, 'base64'));
    full.sign([creator]); // wallet signs the whole tx (keeps the mint sig)
    const signedTxB64 = Buffer.from(full.serialize()).toString('base64');

    const { txSig } = mergeCreatorSignature(txB64, { signedTxB64 });
    expect(txSig).toBe(bs58.encode(full.signatures[0]!));
  });

  it('rejects a signed tx whose message differs from ours', () => {
    const creator = Keypair.generate();
    const mint = Keypair.generate();
    const { txB64 } = prepared(creator, mint);

    // A different tx (new mint) fully signed by the creator — must not pass.
    const other = buildCreateTx(creator, Keypair.generate());
    other.sign([creator]);
    const signedTxB64 = Buffer.from(other.serialize()).toString('base64');
    expect(() => mergeCreatorSignature(txB64, { signedTxB64 })).toThrowError(/different transaction/);
  });
});
