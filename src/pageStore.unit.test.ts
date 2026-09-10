import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as fsp from 'fs/promises';
import { PageMeta, pageDigest, serializeSynced } from './pageFile';
import { sidecarPathFor } from './sidecar';
import {
  loadPage,
  pageNeedsRewrite,
  renameSidecar,
  savePage,
} from './pageStore';

let dir: string;
beforeEach(async () => {
  dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'wikijs-pagestore-'));
});
afterEach(async () => {
  await fsp.rm(dir, { recursive: true, force: true });
});

const meta = (over: Partial<PageMeta> = {}): PageMeta => ({
  id: 5,
  title: 'Intro',
  description: '',
  path: 'Products/x/intro',
  editor: 'markdown',
  locale: 'en',
  isPublished: true,
  isPrivate: false,
  tags: [],
  updatedAt: '2026-09-11T00:00:00.000Z',
  ...over,
});

const read = (p: string) => fsp.readFile(p, 'utf8');
const exists = (p: string) =>
  fsp
    .access(p)
    .then(() => true)
    .catch(() => false);

describe('savePage / loadPage — frontmatter mode', () => {
  it('round-trips through a --- block and stamps a syncHash', async () => {
    const md = path.join(dir, 'intro.md');
    await savePage(md, meta(), 'Body\n', {
      storage: 'frontmatter',
      stampSyncHash: true,
    });

    const text = await read(md);
    expect(text.startsWith('---\n')).toBe(true);
    expect(await exists(sidecarPathFor(md))).toBe(false);

    const loaded = await loadPage(md);
    expect(loaded.metaSource).toBe('frontmatter');
    expect(loaded.content).toBe('Body\n');
    expect(loaded.meta.syncHash).toBe(pageDigest(loaded.meta, 'Body\n'));
  });
});

describe('savePage / loadPage — sidecar mode', () => {
  it('leaves the .md as pure Markdown and writes the sidecar', async () => {
    const md = path.join(dir, 'intro.md');
    await savePage(md, meta(), '# Intro\n\nBody\n', {
      storage: 'sidecar',
      stampSyncHash: true,
    });

    expect(await read(md)).toBe('# Intro\n\nBody\n');
    const side = await read(sidecarPathFor(md));
    expect(side).toContain('id: 5');
    expect(side).toContain('syncHash: ');

    const loaded = await loadPage(md);
    expect(loaded.metaSource).toBe('sidecar');
    expect(loaded.content).toBe('# Intro\n\nBody\n');
    expect(loaded.meta.id).toBe(5);
    expect(loaded.meta.syncHash).toBe(
      pageDigest(loaded.meta, '# Intro\n\nBody\n')
    );
  });

  it('sidecar wins and any stray front matter is stripped from the body', async () => {
    const md = path.join(dir, 'intro.md');
    await fsp.writeFile(
      md,
      serializeSynced(meta({ title: 'STALE' }), 'Body\n')
    );
    await fsp.writeFile(
      sidecarPathFor(md),
      'id: 5\ntitle: Fresh\ndescription: \neditor: markdown\nlocale: en\n' +
        'isPublished: true\nisPrivate: false\ntags: []\n'
    );

    const loaded = await loadPage(md);
    expect(loaded.metaSource).toBe('sidecar');
    expect(loaded.meta.title).toBe('Fresh');
    expect(loaded.content).toBe('Body\n');
  });
});

describe('mode switch', () => {
  it('frontmatter -> sidecar migrates and removes the block; back again removes the sidecar', async () => {
    const md = path.join(dir, 'intro.md');
    await savePage(md, meta(), 'Body\n', {
      storage: 'frontmatter',
      stampSyncHash: true,
    });

    let loaded = await loadPage(md);
    expect(pageNeedsRewrite(loaded, 'sidecar')).toBe(true);
    const hashBefore = loaded.meta.syncHash;

    await savePage(md, loaded.meta, loaded.content, {
      storage: 'sidecar',
      stampSyncHash: false,
    });
    expect(await read(md)).toBe('Body\n');
    loaded = await loadPage(md);
    expect(loaded.metaSource).toBe('sidecar');
    expect(loaded.meta.syncHash).toBe(hashBefore); // offline tidy keeps the hash
    expect(pageNeedsRewrite(loaded, 'sidecar')).toBe(false);

    // ...and back to frontmatter
    expect(pageNeedsRewrite(loaded, 'frontmatter')).toBe(true);
    await savePage(md, loaded.meta, loaded.content, {
      storage: 'frontmatter',
      stampSyncHash: false,
    });
    expect(await exists(sidecarPathFor(md))).toBe(false);
    expect(await read(md)).toBe(serializeSynced(loaded.meta, 'Body\n'));
  });
});

describe('pageNeedsRewrite', () => {
  it('is false for a plain .md with no metadata anywhere', async () => {
    const md = path.join(dir, 'plain.md');
    await fsp.writeFile(md, '# Just markdown\n');
    const loaded = await loadPage(md);
    expect(loaded.metaSource).toBe('none');
    expect(pageNeedsRewrite(loaded, 'frontmatter')).toBe(false);
    expect(pageNeedsRewrite(loaded, 'sidecar')).toBe(false);
  });
});

describe('renameSidecar', () => {
  it('follows the .md to its new path', async () => {
    const oldMd = path.join(dir, 'a.md');
    const newMd = path.join(dir, 'sub', 'b.md');
    await fsp.mkdir(path.join(dir, 'sub'));
    await savePage(oldMd, meta(), 'Body\n', {
      storage: 'sidecar',
      stampSyncHash: true,
    });

    expect(await renameSidecar(oldMd, newMd)).toBe(true);
    expect(await exists(sidecarPathFor(oldMd))).toBe(false);
    expect(await exists(sidecarPathFor(newMd))).toBe(true);
    expect(await renameSidecar(oldMd, newMd)).toBe(false); // nothing left to move
  });
});
