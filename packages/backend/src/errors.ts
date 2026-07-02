/** Raised when a debit/withdrawal/purchase would push an account below zero. */
export class InsufficientFundsError extends Error {
  constructor(
    public readonly accountId: string,
    public readonly available: bigint,
    public readonly requested: bigint,
  ) {
    super(
      `Insufficient funds in account ${accountId}: available ${available}, requested ${requested}`,
    );
    this.name = 'InsufficientFundsError';
  }
}

/** Raised if a set of ledger legs does not sum to zero (double-entry violation). */
export class LedgerImbalanceError extends Error {
  constructor(public readonly sum: bigint) {
    super(`Ledger legs do not balance to zero (sum=${sum})`);
    this.name = 'LedgerImbalanceError';
  }
}

/** Raised for malformed amounts (non-bigint, non-positive where positive required). */
export class InvalidAmountError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidAmountError';
  }
}
