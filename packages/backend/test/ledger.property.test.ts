import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { prisma } from '../src/db.js';
import {
  deposit,
  withdraw,
  refund,
  settlePurchase,
  getSettledBalance,
  getSystemTotal,
} from '../src/ledger.js';
import { InsufficientFundsError } from '../src/errors.js';
import { splitAmount, SYSTEM_ACCOUNT_IDS } from '@bidit/shared';
import { resetDb, makeUser } from './setup.js';

const ACCOUNTS = 3;
const amount = fc.bigInt({ min: 1n, max: 100_000_000n }); // up to $100
const idx = fc.integer({ min: 0, max: ACCOUNTS - 1 });

type Command =
  | { kind: 'deposit'; acct: number; amount: bigint }
  | { kind: 'withdraw'; acct: number; amount: bigint }
  | { kind: 'refund'; acct: number; amount: bigint }
  | { kind: 'settle'; buyer: number; seller: number; amount: bigint };

const command: fc.Arbitrary<Command> = fc.oneof(
  fc.record({ kind: fc.constant('deposit' as const), acct: idx, amount }),
  fc.record({ kind: fc.constant('withdraw' as const), acct: idx, amount }),
  fc.record({ kind: fc.constant('refund' as const), acct: idx, amount }),
  fc.record({ kind: fc.constant('settle' as const), buyer: idx, seller: idx, amount }),
);

describe('ledger invariants (property-based)', () => {
  it('split never leaks a micro-unit for any amount', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: 10n ** 18n }), (amt) => {
        const { platformFee, sellerProceeds } = splitAmount(amt);
        expect(platformFee + sellerProceeds).toBe(amt);
        expect(platformFee).toBe((amt * 500n) / 10_000n);
        expect(platformFee).toBeGreaterThanOrEqual(0n);
        expect(sellerProceeds).toBeGreaterThanOrEqual(0n);
      }),
    );
  });

  it('engine matches a reference model; money is conserved and never negative', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(command, { minLength: 1, maxLength: 12 }), async (program) => {
        await resetDb();
        const accts: string[] = [];
        for (let i = 0; i < ACCOUNTS; i += 1) {
          accts.push((await makeUser('buyer')).accountId);
        }

        // Reference model the engine must agree with.
        const model = new Array<bigint>(ACCOUNTS).fill(0n);
        let platform = 0n;
        let external = 0n;

        for (const cmd of program) {
          if (cmd.kind === 'deposit' || cmd.kind === 'refund') {
            model[cmd.acct]! += cmd.amount;
            external -= cmd.amount;
            const op = cmd.kind === 'deposit' ? deposit : refund;
            await op({ accountId: accts[cmd.acct]!, amount: cmd.amount }, prisma);
          } else if (cmd.kind === 'withdraw') {
            if (model[cmd.acct]! >= cmd.amount) {
              model[cmd.acct]! -= cmd.amount;
              external += cmd.amount;
              await withdraw({ accountId: accts[cmd.acct]!, amount: cmd.amount }, prisma);
            } else {
              await expect(
                withdraw({ accountId: accts[cmd.acct]!, amount: cmd.amount }, prisma),
              ).rejects.toBeInstanceOf(InsufficientFundsError);
            }
          } else {
            const args = {
              buyerAccountId: accts[cmd.buyer]!,
              sellerAccountId: accts[cmd.seller]!,
              amount: cmd.amount,
            };
            if (model[cmd.buyer]! >= cmd.amount) {
              const { platformFee, sellerProceeds } = splitAmount(cmd.amount);
              model[cmd.buyer]! -= cmd.amount;
              model[cmd.seller]! += sellerProceeds;
              platform += platformFee;
              await settlePurchase(args, prisma);
            } else {
              await expect(settlePurchase(args, prisma)).rejects.toBeInstanceOf(
                InsufficientFundsError,
              );
            }
          }
        }

        // Engine == model, account by account.
        for (let i = 0; i < ACCOUNTS; i += 1) {
          expect(await getSettledBalance(accts[i]!, prisma)).toBe(model[i]);
          expect(model[i]).toBeGreaterThanOrEqual(0n); // USER accounts never negative
        }
        expect(await getSettledBalance(SYSTEM_ACCOUNT_IDS.PLATFORM, prisma)).toBe(platform);
        expect(await getSettledBalance(SYSTEM_ACCOUNT_IDS.EXTERNAL, prisma)).toBe(external);
        expect(await getSystemTotal(prisma)).toBe(0n);
      }),
      { numRuns: 25 },
    );
  });
});
