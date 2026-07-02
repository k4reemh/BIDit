import { describe, it, expect } from 'vitest';
import RedisMock from 'ioredis-mock';
import type { Redis } from 'ioredis';
import { InMemoryBus } from '../src/realtime/bus.js';
import { RedisBus } from '../src/realtime/redisBus.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitUntil(fn: () => boolean, timeout = 1000): Promise<void> {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > timeout) throw new Error('waitUntil timed out');
    await sleep(5);
  }
}

describe('InMemoryBus', () => {
  it('delivers a published payload to every subscriber of the channel only', async () => {
    const bus = new InMemoryBus();
    const x1: string[] = [];
    const x2: string[] = [];
    const y: string[] = [];
    await bus.subscribe('room:x', (p) => x1.push(p));
    await bus.subscribe('room:x', (p) => x2.push(p));
    await bus.subscribe('room:y', (p) => y.push(p));

    await bus.publish('room:x', 'hello');
    await sleep(10);

    expect(x1).toEqual(['hello']);
    expect(x2).toEqual(['hello']);
    expect(y).toEqual([]);
  });

  it('stops delivering after unsubscribe', async () => {
    const bus = new InMemoryBus();
    const got: string[] = [];
    const unsub = await bus.subscribe('c', (p) => got.push(p));
    await unsub();
    await bus.publish('c', 'nope');
    await sleep(10);
    expect(got).toEqual([]);
  });
});

describe('RedisBus (ioredis-mock)', () => {
  const makeClient = (base: unknown): Redis => {
    const anyBase = base as { createConnectedClient?: () => unknown };
    const client = typeof anyBase.createConnectedClient === 'function'
      ? anyBase.createConnectedClient()
      : new RedisMock();
    return client as unknown as Redis;
  };

  it('fans a publish out to a subscriber on a separate bus instance', async () => {
    const base = new RedisMock();
    const bus1 = new RedisBus(makeClient(base), makeClient(base)); // "instance 1"
    const bus2 = new RedisBus(makeClient(base), makeClient(base)); // "instance 2"

    const got: string[] = [];
    await bus2.subscribe('room:z', (p) => got.push(p));
    await bus1.publish('room:z', 'cross-instance');

    await waitUntil(() => got.length > 0);
    expect(got).toEqual(['cross-instance']);

    await bus1.close();
    await bus2.close();
  });
});
