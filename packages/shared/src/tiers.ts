/**
 * Chat name tiers, earned with BIDit Points. The tier is computed server-side
 * when a message is posted and snapshotted on it (like the handle), so a chat
 * line always shows the rank its sender held when they said it. Colors and glow
 * live in the clients; this is the single ladder both sides agree on.
 */

export type ChatTierId = 'none' | 'bronze' | 'silver' | 'gold' | 'diamond' | 'legend';

export interface ChatTierDef {
  id: ChatTierId;
  name: string;
  minPoints: bigint;
}

/** Highest first: the first rung whose floor the points clear wins. */
export const CHAT_TIERS: readonly ChatTierDef[] = [
  { id: 'legend', name: 'Legend', minPoints: 1_000_000n },
  { id: 'diamond', name: 'Diamond', minPoints: 250_000n },
  { id: 'gold', name: 'Gold', minPoints: 50_000n },
  { id: 'silver', name: 'Silver', minPoints: 10_000n },
  { id: 'bronze', name: 'Bronze', minPoints: 1_000n },
] as const;

export function chatTierFor(points: bigint): ChatTierId {
  for (const tier of CHAT_TIERS) {
    if (points >= tier.minPoints) return tier.id;
  }
  return 'none';
}
