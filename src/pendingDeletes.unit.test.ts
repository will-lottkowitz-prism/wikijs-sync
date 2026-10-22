import { describe, it, expect } from 'vitest';
import {
  addPending,
  findPending,
  listPending,
  removePending,
  Store,
} from './pendingDeletes';

const memStore = (): Store => {
  const m = new Map<string, unknown>();
  return {
    get: <T>(k: string, d: T) => (m.has(k) ? (m.get(k) as T) : d),
    update: async (k, v) => void m.set(k, v),
  };
};
const e = { url: 'http://w', root: '/r', path: 'A/B', id: 7 };

describe('pendingDeletes', () => {
  it('adds, de-duplicates and removes', async () => {
    const s = memStore();
    await addPending(s, e);
    await addPending(s, { ...e, updatedAt: 'x' });
    expect(listPending(s)).toHaveLength(1);
    await removePending(s, e);
    expect(listPending(s)).toHaveLength(0);
  });
  it('keeps entries for other roots apart', async () => {
    const s = memStore();
    await addPending(s, e);
    await addPending(s, { ...e, root: '/other' });
    expect(listPending(s)).toHaveLength(2);
  });
  it('finds by id, else by path ignoring case', () => {
    expect(findPending([e], { id: 7, path: 'moved' })).toBe(e);
    expect(findPending([e], { id: 8, path: 'A/B' })).toBeUndefined();
    const noId = { url: 'u', root: 'r', path: 'A/B' };
    expect(findPending([noId], { id: 9, path: 'a/b' })).toBe(noId);
  });
});
