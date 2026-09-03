import { describe, it, expect } from 'vitest';
import {
  PageMeta,
  pageDigest,
  parsePageFile,
  sameInstant,
  serializePageFile,
  serializeSynced,
} from './pageFile';

const meta: PageMeta = {
  id: 3,
  title: 'Page Title',
  description: 'desc',
  path: 'Products/x/intro',
  editor: 'markdown',
  locale: 'en',
  isPublished: true,
  isPrivate: false,
  tags: ['b', 'a'],
  updatedAt: '2026-08-06T04:13:34.389Z',
};

describe('pageDigest', () => {
  it('is stable across calls', () => {
    expect(pageDigest(meta, 'body')).toBe(pageDigest(meta, 'body'));
  });
  it('ignores id, updatedAt and syncHash', () => {
    const a = pageDigest({ ...meta, id: 1, updatedAt: 'x' }, 'body');
    const b = pageDigest(
      { ...meta, id: 999, updatedAt: 'y', syncHash: 'z' },
      'body'
    );
    expect(a).toBe(b);
  });
  it('ignores tag order', () => {
    expect(pageDigest({ ...meta, tags: ['a', 'b'] }, 'body')).toBe(
      pageDigest({ ...meta, tags: ['b', 'a'] }, 'body')
    );
  });
  it('ignores path (a move is a location change, not a content edit)', () => {
    expect(pageDigest({ ...meta, path: 'Other/place' }, 'body')).toBe(
      pageDigest(meta, 'body')
    );
  });
  it('changes with the body', () => {
    expect(pageDigest(meta, 'body')).not.toBe(pageDigest(meta, 'other'));
  });
  it('changes with a stored metadata field', () => {
    expect(pageDigest(meta, 'body')).not.toBe(
      pageDigest({ ...meta, title: 'New' }, 'body')
    );
  });
});

describe('serializeSynced round-trips', () => {
  it('writes a syncHash that a fresh digest of the parsed file reproduces', () => {
    const text = serializeSynced(meta, 'Hello\n');
    const { meta: parsed, content } = parsePageFile(text);
    expect(parsed.syncHash).toBe(pageDigest(parsed, content));
    expect(parsed.syncHash).toBe(meta.syncHash ?? pageDigest(meta, 'Hello\n'));
  });
  it('serializePageFile omits syncHash when absent', () => {
    expect(serializePageFile(meta, 'x')).not.toContain('syncHash');
  });
  it('never writes a path line (it is derived from the file location)', () => {
    expect(serializePageFile(meta, 'x')).not.toMatch(/^path:/m);
  });
  it('ignores a stale path line left by an older version', () => {
    const legacy =
      '---\nid: 3\ntitle: T\ndescription: d\npath: Old/stale/location\n' +
      'editor: markdown\nlocale: en\nisPublished: true\nisPrivate: false\n' +
      'tags: []\n---\nbody\n';
    expect(parsePageFile(legacy).meta.path).toBe('');
  });
});

describe('sameInstant', () => {
  it('exact string match', () => {
    expect(
      sameInstant('2026-08-06T04:13:34.389Z', '2026-08-06T04:13:34.389Z')
    ).toBe(true);
  });
  it('same instant, different serialization', () => {
    expect(
      sameInstant('2026-08-06T04:13:34.389Z', '2026-08-06T04:13:34.389+00:00')
    ).toBe(true);
    expect(
      sameInstant('2026-08-06T14:13:34.389+10:00', '2026-08-06T04:13:34.389Z')
    ).toBe(true);
  });
  it('different instants', () => {
    expect(
      sameInstant('2026-08-06T04:13:34.389Z', '2026-08-06T04:13:35.000Z')
    ).toBe(false);
  });
  it('undefined / empty is never a match', () => {
    expect(sameInstant(undefined, '2026-08-06T04:13:34.389Z')).toBe(false);
    expect(sameInstant('2026-08-06T04:13:34.389Z', undefined)).toBe(false);
    expect(sameInstant(undefined, undefined)).toBe(false);
  });
});
