export * from './types.js';
export { MockChain } from './mock.js';

import type { ChainClient } from './types.js';
import { MockChain } from './mock.js';

/**
 * Pick the chain client from the environment. Defaults to the simulated chain;
 * uses real Solana only when SOLANA_RPC is set (lazily imported so web3.js isn't
 * loaded in tests/dev). The Solana impl refuses mainnet unless explicitly opted in.
 */
export async function getChainClient(): Promise<ChainClient> {
  if (process.env.SOLANA_RPC) {
    const { SolanaChain } = await import('./solana.js');
    return SolanaChain.fromEnv();
  }
  return new MockChain();
}
