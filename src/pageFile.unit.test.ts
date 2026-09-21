import { describe, it, expect } from 'vitest';
import {
  PageMeta,
  defaultMetaForFile,
  metaFromFields,
  needsCanonicalRewrite,
  nonDefaultFields,
  pageDigest,
  parsePageFile,
  sameInstant,
  serializePageFile,
  serializeSynced,
} from './pageFile';

const FILE = '/w/docs/page-title.md';

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
    const text = serializeSynced(meta, 'Hello\n', FILE);
    const { meta: parsed, content } = parsePageFile(text, FILE);
    expect(parsed.syncHash).toBe(pageDigest(parsed, content));
    expect(parsed.syncHash).toBe(meta.syncHash ?? pageDigest(meta, 'Hello\n'));
  });
  it('serializePageFile omits syncHash when absent', () => {
    expect(serializePageFile(meta, 'x', FILE)).not.toContain('syncHash');
  });
  it('never writes a path line (it is derived from the file location)', () => {
    expect(serializePageFile(meta, 'x', FILE)).not.toMatch(/^path:/m);
  });
  it('ignores a stale path line left by an older version', () => {
    const legacy =
      '---\nid: 3\ntitle: T\ndescription: d\npath: Old/stale/location\n' +
      'editor: markdown\nlocale: en\nisPublished: true\nisPrivate: false\n' +
      'tags: []\n---\nbody\n';
    expect(parsePageFile(legacy, FILE).meta.path).toBe('');
  });
});

describe('needsCanonicalRewrite', () => {
  const legacyWithPath =
    '---\nid: 3\ntitle: Page Title\ndescription: desc\npath: Old/stale\n' +
    'editor: markdown\nlocale: en\nisPublished: true\nisPrivate: false\n' +
    'tags: [a, b]\nupdatedAt: 2026-08-06T04:13:34.389Z\n---\nbody\n';

  it('is true for a file that still carries a path: line', () => {
    const { meta, content } = parsePageFile(legacyWithPath, FILE);
    expect(needsCanonicalRewrite(legacyWithPath, meta, content, FILE)).toBe(
      true
    );
    // and the canonical form it would be rewritten to has no path line
    expect(serializePageFile(meta, content, FILE)).not.toMatch(/^path:/m);
  });

  it('is false for a file already in canonical form (CRLF tolerated)', () => {
    const text = serializePageFile(meta, 'body\n', FILE);
    const { meta: parsed, content } = parsePageFile(text, FILE);
    expect(needsCanonicalRewrite(text, parsed, content, FILE)).toBe(false);
    expect(
      needsCanonicalRewrite(text.replace(/\n/g, '\r\n'), parsed, content, FILE)
    ).toBe(false);
  });

  it('is true for an unknown/legacy front-matter key', () => {
    const text = serializePageFile(meta, 'body\n', FILE).replace(
      '\n---\nbody\n',
      '\nlegacyKey: 1\n---\nbody\n'
    );
    const { meta: parsed, content } = parsePageFile(text, FILE);
    expect(needsCanonicalRewrite(text, parsed, content, FILE)).toBe(true);
  });
});

describe('default-omitting metadata', () => {
  const body = '# Page Title\n\nHello\n';
  const defaults = defaultMetaForFile(FILE, body);
  const plain: PageMeta = {
    ...defaults,
    id: 3,
    updatedAt: '2026-08-06T04:13:34.389Z',
    syncHash: 'abc',
  };

  it('stores only id / updatedAt / syncHash for an all-default page', () => {
    expect(nonDefaultFields(plain, defaults)).toEqual({
      id: 3,
      updatedAt: '2026-08-06T04:13:34.389Z',
      syncHash: 'abc',
    });
    const text = serializePageFile(plain, body, FILE);
    expect(text).toBe(
      '---\nid: 3\nupdatedAt: 2026-08-06T04:13:34.389Z\nsyncHash: abc\n---\n' +
        body
    );
  });

  it('writes a field once it differs from its default', () => {
    const custom = {
      ...plain,
      title: 'Custom',
      description: 'd',
      isPrivate: true,
      tags: ['x'],
      locale: 'fr',
    };
    expect(Object.keys(nonDefaultFields(custom, defaults))).toEqual([
      'id',
      'title',
      'description',
      'locale',
      'isPrivate',
      'tags',
      'updatedAt',
      'syncHash',
    ]);
  });

  it('round-trips, filling absent keys from the defaults', () => {
    const text = serializePageFile(plain, body, FILE);
    const { meta: parsed, content } = parsePageFile(text, FILE);
    expect(content).toBe(body);
    expect({ ...parsed, path: '' }).toEqual({ ...plain, path: '' });
  });

  it('a default title follows the file: rename it and the title moves too', () => {
    const noHeading = 'Hello\n';
    const before = defaultMetaForFile('/w/docs/old-name.md', noHeading);
    const stored = serializePageFile(
      { ...before, id: 1 },
      noHeading,
      '/w/docs/old-name.md'
    );
    expect(stored).not.toContain('title:');
    // the same text under a new filename now yields the new derived title
    expect(parsePageFile(stored, '/w/docs/new-name.md').meta.title).toBe(
      'New Name'
    );
  });

  it('a heading-derived default title follows an edited heading', () => {
    const stored = serializePageFile(
      { ...defaultMetaForFile(FILE, '# One\n'), id: 1 },
      '# One\n',
      FILE
    );
    expect(stored).not.toContain('title:');
    const edited = stored.replace('# One', '# Two');
    expect(parsePageFile(edited, FILE).meta.title).toBe('Two');
  });

  it('an explicitly different title is kept through a rename', () => {
    const kept = serializePageFile({ ...plain, title: 'Pinned' }, body, FILE);
    expect(parsePageFile(kept, '/w/elsewhere/other.md').meta.title).toBe(
      'Pinned'
    );
  });

  it('a field explicitly set to empty is not mistaken for absent', () => {
    const d = defaultMetaForFile(FILE, 'x');
    const text = serializePageFile({ ...d, title: '' }, 'x', FILE);
    expect(text).toContain('title: ""');
    expect(parsePageFile(text, FILE).meta.title).toBe('');
  });

  it('a page with nothing to store still parses back as front matter', () => {
    const d = defaultMetaForFile(FILE, 'x\n');
    const text = serializePageFile(d, 'x\n', FILE);
    expect(text).toBe('---\n---\nx\n');
    expect(parsePageFile(text, FILE).content).toBe('x\n');
  });

  it('metaFromFields is the inverse of nonDefaultFields', () => {
    const custom = { ...plain, tags: ['b', 'a'], isPublished: false };
    expect({
      ...metaFromFields(nonDefaultFields(custom, defaults), defaults),
      path: '',
    }).toEqual({ ...custom, path: '' });
  });

  it('a legacy fully-written block reads the same and is flagged for tidying', () => {
    const legacy =
      '---\nid: 3\ntitle: Page Title\ndescription: \neditor: markdown\n' +
      'locale: en\nisPublished: true\nisPrivate: false\ntags: []\n' +
      'updatedAt: 2026-08-06T04:13:34.389Z\nsyncHash: abc\n---\n' +
      body;
    const { meta: parsed, content } = parsePageFile(legacy, FILE);
    expect({ ...parsed, path: '' }).toEqual({ ...plain, path: '' });
    expect(needsCanonicalRewrite(legacy, parsed, content, FILE)).toBe(true);
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
