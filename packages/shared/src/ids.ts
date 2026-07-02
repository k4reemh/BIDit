/**
 * Well-known fixed ids for the two singleton system accounts.
 *
 * Using fixed primary keys (rather than random cuids) guarantees there is
 * exactly one of each and lets every part of the system reference them without
 * a lookup.
 *
 *  - EXTERNAL: the boundary between BIDit and the outside world (bank/chain).
 *    Deposits credit a user and debit EXTERNAL; withdrawals do the reverse.
 *    Its balance is the negative of all money currently inside the system.
 *  - PLATFORM: collects the 5% cut from every settled sale. Its balance is the
 *    pool that funds $BID buybacks (the "buyback-pending" tally).
 *  - ESCROW: holds a winner's committed funds between lock and release/refund.
 */
export const SYSTEM_ACCOUNT_IDS = {
  EXTERNAL: 'sys_external',
  PLATFORM: 'sys_platform',
  ESCROW: 'sys_escrow',
} as const;

export type SystemAccountId =
  (typeof SYSTEM_ACCOUNT_IDS)[keyof typeof SYSTEM_ACCOUNT_IDS];

/**
 * The escrow wallet. v1 (DevWalletEscrow) is fully simulated and moves NO real
 * funds — this address is recorded as a reference only. The on-chain ProgramEscrow
 * (a later chunk) is where it becomes a real PDA/wallet.
 */
export const ESCROW_WALLET_ADDRESS = '3BbGvG7ZxXQrodaMWR2vbjVr3431D1V8K8kFPAvgJ76D';
