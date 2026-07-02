/**
 * Redis-backed bus for fan-out across multiple backend instances. Drops in for
 * InMemoryBus without the server knowing the difference. Requires two ioredis
 * connections: one dedicated to SUBSCRIBE (ioredis forbids normal commands on a
 * subscriber connection) and one for PUBLISH.
 */
import { Redis } from 'ioredis';
import type { BusHandler, RealtimeBus, Unsubscribe } from './bus.js';

export class RedisBus implements RealtimeBus {
  private readonly handlers = new Map<string, Set<BusHandler>>();

  constructor(
    private readonly pub: Redis,
    private readonly sub: Redis,
  ) {
    this.sub.on('message', (channel: string, message: string) => {
      const set = this.handlers.get(channel);
      if (!set) return;
      for (const handler of [...set]) handler(message);
    });
  }

  async publish(channel: string, payload: string): Promise<void> {
    await this.pub.publish(channel, payload);
  }

  async subscribe(channel: string, handler: BusHandler): Promise<Unsubscribe> {
    let set = this.handlers.get(channel);
    if (!set) {
      set = new Set();
      this.handlers.set(channel, set);
      await this.sub.subscribe(channel);
    }
    set.add(handler);
    return async () => {
      const current = this.handlers.get(channel);
      if (!current) return;
      current.delete(handler);
      if (current.size === 0) {
        this.handlers.delete(channel);
        await this.sub.unsubscribe(channel);
      }
    };
  }

  async close(): Promise<void> {
    await Promise.allSettled([this.pub.quit(), this.sub.quit()]);
  }
}

/** Build a RedisBus from a connection URL (e.g. redis://localhost:6379). */
export function createRedisBus(url: string): RedisBus {
  return new RedisBus(new Redis(url), new Redis(url));
}
