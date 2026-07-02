/**
 * Pub/sub abstraction for fan-out. The realtime server publishes to a channel
 * (e.g. `room:{sellerId}` or `user:{userId}`) and every backend instance with a
 * local socket on that channel delivers the payload. Payloads are pre-serialized
 * JSON strings so the same interface works in-process or over Redis.
 */
export type BusHandler = (payload: string) => void;
export type Unsubscribe = () => Promise<void>;

export interface RealtimeBus {
  publish(channel: string, payload: string): Promise<void>;
  subscribe(channel: string, handler: BusHandler): Promise<Unsubscribe>;
  close(): Promise<void>;
}

/**
 * Single-process bus. Sufficient for one backend instance (the Chunk 3 dev
 * server and the browser-tab acceptance test). Delivery is deferred to a
 * microtask to mimic the network and avoid publish-time reentrancy.
 */
export class InMemoryBus implements RealtimeBus {
  private channels = new Map<string, Set<BusHandler>>();

  async publish(channel: string, payload: string): Promise<void> {
    const handlers = this.channels.get(channel);
    if (!handlers) return;
    for (const handler of [...handlers]) {
      queueMicrotask(() => handler(payload));
    }
  }

  async subscribe(channel: string, handler: BusHandler): Promise<Unsubscribe> {
    let set = this.channels.get(channel);
    if (!set) {
      set = new Set();
      this.channels.set(channel, set);
    }
    set.add(handler);
    return async () => {
      const current = this.channels.get(channel);
      if (!current) return;
      current.delete(handler);
      if (current.size === 0) this.channels.delete(channel);
    };
  }

  async close(): Promise<void> {
    this.channels.clear();
  }
}
