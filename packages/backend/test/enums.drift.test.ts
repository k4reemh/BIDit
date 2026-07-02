import { describe, it, expect } from 'vitest';
import * as PrismaPkg from '@prisma/client';
import * as Shared from '@bidit/shared';

/**
 * Guards the single most dangerous kind of drift: the wire/domain enums in
 * @bidit/shared silently diverging from the database enums Prisma generates.
 * If these ever disagree, this test fails before any bad data can be written.
 */
function valuesOf(obj: Record<string, string>): string[] {
  return Object.values(obj).sort();
}

const cases: Array<[string, Record<string, string>, unknown]> = [
  ['Role', Shared.Role, (PrismaPkg as Record<string, unknown>).Role],
  ['AccountKind', Shared.AccountKind, (PrismaPkg as Record<string, unknown>).AccountKind],
  ['LedgerType', Shared.LedgerType, (PrismaPkg as Record<string, unknown>).LedgerType],
  ['LedgerRefType', Shared.LedgerRefType, (PrismaPkg as Record<string, unknown>).LedgerRefType],
  ['ListingStatus', Shared.ListingStatus, (PrismaPkg as Record<string, unknown>).ListingStatus],
  ['AuctionStatus', Shared.AuctionStatus, (PrismaPkg as Record<string, unknown>).AuctionStatus],
  ['BidStatus', Shared.BidStatus, (PrismaPkg as Record<string, unknown>).BidStatus],
  ['OrderStatus', Shared.OrderStatus, (PrismaPkg as Record<string, unknown>).OrderStatus],
  ['HoldStatus', Shared.HoldStatus, (PrismaPkg as Record<string, unknown>).HoldStatus],
];

describe('shared enums match the Prisma schema', () => {
  for (const [name, shared, prismaEnum] of cases) {
    it(`${name} values are identical`, () => {
      expect(prismaEnum, `Prisma should export enum ${name}`).toBeTruthy();
      expect(valuesOf(prismaEnum as Record<string, string>)).toEqual(valuesOf(shared));
    });
  }
});
