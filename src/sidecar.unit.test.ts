import { describe, it, expect } from 'vitest';
import { PageMeta } from './pageFile';
import {
  isSidecarName,
  parseSidecar,
  serializeSidecar,
  sidecarIsCanonical,
  sidecarPathFor,
} from './sidecar';

const meta: PageMeta = {
  id: 7,
  title: 'Page: Title',
  description: 'a, b',
  path: 'Products/x/intro',
  editor: 'markdown',
  locale: 'en',
  isPublished: true,
  isPrivate: false,
  tags: ['b', 'a'],
  updatedAt: '2026-09-11T04:13:34.389Z',
  syncHash: 'deadbeef',
};

describe('sidecarPathFor', () => {
  it('is a hidden sibling of the .md file', () => {
    expect(sidecarPathFor('/w/docs/guide/intro.md').replace(/\\/g, '/')).toBe(
      '/w/docs/guide/.intro.md.wikisync.yaml'
    );
  });
});

describe('isSidecarName', () => {
  it('matches a sidecar, not a page or config', () => {
    expect(isSidecarName('.intro.md.wikisync.yaml')).toBe(true);
    expect(isSidecarName('intro.md')).toBe(false);
    expect(isSidecarName('.wikisync.json')).toBe(false);
    expect(isSidecarName('notes.yaml')).toBe(false);
  });
});

describe('serialize / parse round-trip', () => {
  it('recovers every field', () => {
    const parsed = parseSidecar(serializeSidecar(meta));
    expect({ ...parsed, path: meta.path }).toEqual(meta);
  });

  it('tolerates CRLF and skips the comment header', () => {
    const crlf = serializeSidecar(meta).replace(/\n/g, '\r\n');
    const parsed = parseSidecar(crlf);
    expect(parsed.id).toBe(7);
    expect(parsed.tags).toEqual(['b', 'a']);
    expect(parsed.syncHash).toBe('deadbeef');
  });

  it('omits updatedAt / syncHash when absent', () => {
    const bare = serializeSidecar({
      ...meta,
      updatedAt: undefined,
      syncHash: undefined,
    });
    expect(bare).not.toContain('updatedAt');
    expect(bare).not.toContain('syncHash');
  });
});

describe('sidecarIsCanonical', () => {
  it('true for its own output, false once edited', () => {
    const text = serializeSidecar(meta);
    expect(sidecarIsCanonical(text, meta)).toBe(true);
    expect(sidecarIsCanonical(text + 'stray: 1\n', meta)).toBe(false);
    expect(sidecarIsCanonical(text.replace(/\n/g, '\r\n'), meta)).toBe(true);
  });
});
