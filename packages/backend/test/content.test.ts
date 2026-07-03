import { describe, it, expect, beforeEach } from 'vitest';
import { prisma } from '../src/db.js';
import { getAllContent, setContent } from '../src/content.js';
import { resetDb } from './setup.js';

beforeEach(async () => {
  await resetDb();
});

describe('site content', () => {
  it('upserts and reads back copy overrides', async () => {
    expect(await getAllContent(prisma)).toEqual({});
    const n = await setContent({ 'home.hero.title': 'Hello', 'home.live.title': 'Live' }, prisma);
    expect(n).toBe(2);
    expect(await getAllContent(prisma)).toEqual({ 'home.hero.title': 'Hello', 'home.live.title': 'Live' });

    await setContent({ 'home.hero.title': 'Changed' }, prisma); // update in place
    expect((await getAllContent(prisma))['home.hero.title']).toBe('Changed');
  });
});
