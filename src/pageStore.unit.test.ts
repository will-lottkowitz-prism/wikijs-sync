import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as fsp from 'fs/promises';
import {
  PageMeta,
  defaultMetaForFile,
  pageDigest,
  serializeSynced,
} from './pageFile';
import { sidecarPathFor } from './sidecar';
import {
  CENTRAL_FILENAME,
  centralPathFor,
  pruneCentralOrphans,
} from './centralStore';
import {
  MetaLocation,
  loadPage,
  pageNeedsRewrite,
  relocateMetadata,
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

const fm = (): MetaLocation => ({ storage: 'frontmatter', root: dir });
const side = (): MetaLocation => ({ storage: 'sidecar', root: dir });
const single = (): MetaLocation => ({ storage: 'single-file', root: dir });

// A page whose every field but the bookkeeping is at its default for `md`/`body`.
const metaFor = (
  md: string,
  body: string,
  over: Partial<PageMeta> = {}
): PageMeta => ({
  ...defaultMetaForFile(md, body),
  id: 5,
  path: 'Products/x/intro',
  updatedAt: '2026-09-11T00:00:00.000Z',
  ...over,
});

const read = (p: string) => fsp.readFile(p, 'utf8');
const readJson = async (p: string) => JSON.parse(await read(p));
const exists = (p: string) =>
  fsp
    .access(p)
    .then(() => true)
    .catch(() => false);

describe('savePage / loadPage — frontmatter mode', () => {
  it('round-trips through a --- block and stamps a syncHash', async () => {
    const md = path.join(dir, 'intro.md');
    await savePage(md, metaFor(md, 'Body\n'), 'Body\n', {
      ...fm(),
      stampSyncHash: true,
    });

    const text = await read(md);
    expect(text.startsWith('---\n')).toBe(true);
    expect(await exists(sidecarPathFor(md))).toBe(false);
    expect(await exists(centralPathFor(dir))).toBe(false);

    const loaded = await loadPage(md, fm());
    expect(loaded.metaSource).toBe('frontmatter');
    expect(loaded.content).toBe('Body\n');
    expect(loaded.meta.title).toBe('Intro');
    expect(loaded.meta.syncHash).toBe(pageDigest(loaded.meta, 'Body\n'));
  });

  it('does not write fields that are at their default', async () => {
    const md = path.join(dir, 'intro.md');
    await savePage(md, metaFor(md, 'Body\n'), 'Body\n', {
      ...fm(),
      stampSyncHash: true,
    });
    const text = await read(md);
    expect(text).toMatch(/^id: 5$/m);
    for (const key of ['title', 'description', 'editor', 'locale', 'tags']) {
      expect(text).not.toMatch(new RegExp(`^${key}:`, 'm'));
    }
  });
});

describe('savePage / loadPage — sidecar mode', () => {
  it('leaves the .md as pure Markdown and writes the sidecar', async () => {
    const md = path.join(dir, 'intro.md');
    const body = '# Intro\n\nBody\n';
    await savePage(md, metaFor(md, body), body, {
      ...side(),
      stampSyncHash: true,
    });

    expect(await read(md)).toBe(body);
    const sc = await read(sidecarPathFor(md));
    expect(sc).toContain('id: 5');
    expect(sc).toContain('syncHash: ');
    expect(sc).not.toContain('title:'); // it is just the heading

    const loaded = await loadPage(md, side());
    expect(loaded.metaSource).toBe('sidecar');
    expect(loaded.content).toBe(body);
    expect(loaded.meta.id).toBe(5);
    expect(loaded.meta.title).toBe('Intro');
    expect(loaded.meta.syncHash).toBe(pageDigest(loaded.meta, body));
  });

  it('sidecar wins and any stray front matter is stripped from the body', async () => {
    const md = path.join(dir, 'intro.md');
    await fsp.writeFile(
      md,
      serializeSynced(metaFor(md, 'Body\n', { title: 'STALE' }), 'Body\n', md)
    );
    await fsp.writeFile(
      sidecarPathFor(md),
      'id: 5\ntitle: Fresh\ndescription: \neditor: markdown\nlocale: en\n' +
        'isPublished: true\nisPrivate: false\ntags: []\n'
    );

    const loaded = await loadPage(md, side());
    expect(loaded.metaSource).toBe('sidecar');
    expect(loaded.meta.title).toBe('Fresh');
    expect(loaded.content).toBe('Body\n');
  });
});

describe('savePage / loadPage — single-file mode', () => {
  it('keeps the .md pure and records the page in .wikijs.metadata.json', async () => {
    const md = path.join(dir, 'guide', 'intro.md');
    await fsp.mkdir(path.dirname(md));
    const body = '# Intro\n\nBody\n';
    await savePage(md, metaFor(md, body), body, {
      ...single(),
      stampSyncHash: true,
    });

    expect(await read(md)).toBe(body);
    expect(await exists(sidecarPathFor(md))).toBe(false);
    const json = await readJson(centralPathFor(dir));
    expect(json.version).toBe(1);
    expect(Object.keys(json.pages)).toEqual(['guide/intro.md']);
    // id + bookkeeping only: title is the heading, everything else is default
    expect(Object.keys(json.pages['guide/intro.md'])).toEqual([
      'id',
      'updatedAt',
      'syncHash',
    ]);

    const loaded = await loadPage(md, single());
    expect(loaded.metaSource).toBe('single-file');
    expect(loaded.content).toBe(body);
    expect(loaded.meta.id).toBe(5);
    expect(loaded.meta.title).toBe('Intro');
    expect(loaded.meta.syncHash).toBe(pageDigest(loaded.meta, body));
    expect(pageNeedsRewrite(loaded, 'single-file')).toBe(false);
  });

  it('stores a non-default field and keeps it', async () => {
    const md = path.join(dir, 'intro.md');
    await savePage(
      md,
      metaFor(md, 'Body\n', { title: 'Pinned', tags: ['a'], isPrivate: true }),
      'Body\n',
      { ...single(), stampSyncHash: false }
    );
    const entry = (await readJson(centralPathFor(dir))).pages['intro.md'];
    expect(entry).toMatchObject({
      title: 'Pinned',
      tags: ['a'],
      isPrivate: true,
    });
    const loaded = await loadPage(md, single());
    expect(loaded.meta.title).toBe('Pinned');
    expect(loaded.meta.tags).toEqual(['a']);
    expect(loaded.meta.isPrivate).toBe(true);
  });

  it('holds many pages in one file, keys sorted', async () => {
    for (const name of ['b.md', 'a.md', 'c.md']) {
      const md = path.join(dir, name);
      await savePage(md, metaFor(md, 'x\n'), 'x\n', {
        ...single(),
        stampSyncHash: true,
      });
    }
    const json = await readJson(centralPathFor(dir));
    expect(Object.keys(json.pages)).toEqual(['a.md', 'b.md', 'c.md']);
  });

  it('serializes concurrent saves without losing an entry', async () => {
    const names = Array.from({ length: 20 }, (_, i) => `p${i}.md`);
    await Promise.all(
      names.map((n) => {
        const md = path.join(dir, n);
        return savePage(md, metaFor(md, 'x\n'), 'x\n', {
          ...single(),
          stampSyncHash: true,
        });
      })
    );
    const json = await readJson(centralPathFor(dir));
    expect(Object.keys(json.pages).sort()).toEqual([...names].sort());
  });

  it('refuses to overwrite a central file it cannot parse', async () => {
    const md = path.join(dir, 'intro.md');
    await fsp.writeFile(md, 'Body\n');
    await fsp.writeFile(centralPathFor(dir), '{ not json');
    await expect(loadPage(md, single())).rejects.toThrow(/not valid JSON/);
    await expect(
      savePage(md, metaFor(md, 'Body\n'), 'Body\n', {
        ...single(),
        stampSyncHash: true,
      })
    ).rejects.toThrow(/not valid JSON/);
    expect(await read(centralPathFor(dir))).toBe('{ not json');
    // ...but a broken file doesn't take a non-central folder down with it
    await expect(loadPage(md, fm())).resolves.toBeTruthy();
  });

  it('rejects a page outside the root', async () => {
    const other = await fsp.mkdtemp(path.join(os.tmpdir(), 'wikijs-outside-'));
    try {
      const md = path.join(other, 'x.md');
      await expect(
        savePage(md, metaFor(md, 'x'), 'x', {
          ...single(),
          stampSyncHash: false,
        })
      ).rejects.toThrow(/outside/);
    } finally {
      await fsp.rm(other, { recursive: true, force: true });
    }
  });
});

describe('mode switching', () => {
  it('frontmatter -> sidecar migrates and removes the block; back again removes the sidecar', async () => {
    const md = path.join(dir, 'intro.md');
    await savePage(md, metaFor(md, 'Body\n'), 'Body\n', {
      ...fm(),
      stampSyncHash: true,
    });

    let loaded = await loadPage(md, side());
    expect(pageNeedsRewrite(loaded, 'sidecar')).toBe(true);
    const hashBefore = loaded.meta.syncHash;

    await savePage(md, loaded.meta, loaded.content, {
      ...side(),
      stampSyncHash: false,
    });
    expect(await read(md)).toBe('Body\n');
    loaded = await loadPage(md, side());
    expect(loaded.metaSource).toBe('sidecar');
    expect(loaded.meta.syncHash).toBe(hashBefore); // offline tidy keeps the hash
    expect(pageNeedsRewrite(loaded, 'sidecar')).toBe(false);

    // ...and back to frontmatter
    expect(pageNeedsRewrite(loaded, 'frontmatter')).toBe(true);
    await savePage(md, loaded.meta, loaded.content, {
      ...fm(),
      stampSyncHash: false,
    });
    expect(await exists(sidecarPathFor(md))).toBe(false);
    expect(await read(md)).toBe(serializeSynced(loaded.meta, 'Body\n', md));
  });

  it('every pair of modes migrates leaving exactly one copy and no id loss', async () => {
    const modes: MetaLocation[] = [fm(), side(), single()];
    for (const from of modes) {
      for (const to of modes) {
        if (from.storage === to.storage) continue;
        const md = path.join(dir, `${from.storage}-to-${to.storage}.md`);
        await savePage(md, metaFor(md, 'Body\n', { tags: ['t'] }), 'Body\n', {
          ...from,
          stampSyncHash: true,
        });

        const loaded = await loadPage(md, to);
        expect(loaded.meta.id).toBe(5);
        expect(loaded.meta.tags).toEqual(['t']);
        expect(pageNeedsRewrite(loaded, to.storage)).toBe(true);

        await savePage(md, loaded.meta, loaded.content, {
          ...to,
          stampSyncHash: false,
        });
        const again = await loadPage(md, to);
        expect(again.metaSource).toBe(to.storage);
        expect(again.meta).toEqual(loaded.meta);
        expect(pageNeedsRewrite(again, to.storage)).toBe(false);
        // the old home is cleaned out
        expect(await exists(sidecarPathFor(md))).toBe(to.storage === 'sidecar');
        if (to.storage !== 'single-file') {
          const json = await readJson(centralPathFor(dir)).catch(() => ({
            pages: {},
          }));
          expect(Object.keys(json.pages)).not.toContain(path.basename(md));
        }
      }
    }
  });

  it('removes the central file once its last entry migrates away', async () => {
    const md = path.join(dir, 'intro.md');
    await savePage(md, metaFor(md, 'Body\n'), 'Body\n', {
      ...single(),
      stampSyncHash: true,
    });
    expect(await exists(centralPathFor(dir))).toBe(true);
    const loaded = await loadPage(md, fm());
    await savePage(md, loaded.meta, loaded.content, {
      ...fm(),
      stampSyncHash: false,
    });
    expect(await exists(centralPathFor(dir))).toBe(false);
  });
});

describe('pageNeedsRewrite', () => {
  it('is false for a plain .md with no metadata anywhere', async () => {
    const md = path.join(dir, 'plain.md');
    await fsp.writeFile(md, '# Just markdown\n');
    const loaded = await loadPage(md, fm());
    expect(loaded.metaSource).toBe('none');
    for (const mode of ['frontmatter', 'sidecar', 'single-file'] as const) {
      expect(pageNeedsRewrite(loaded, mode)).toBe(false);
    }
  });

  it('flags a legacy front-matter block that spells out defaults', async () => {
    const md = path.join(dir, 'intro.md');
    await fsp.writeFile(
      md,
      '---\nid: 5\ntitle: Intro\ndescription: \neditor: markdown\nlocale: en\n' +
        'isPublished: true\nisPrivate: false\ntags: []\n---\nBody\n'
    );
    const loaded = await loadPage(md, fm());
    expect(loaded.meta.title).toBe('Intro');
    expect(pageNeedsRewrite(loaded, 'frontmatter')).toBe(true);
    await savePage(md, loaded.meta, loaded.content, {
      ...fm(),
      stampSyncHash: false,
    });
    expect(await read(md)).toBe('---\nid: 5\n---\nBody\n');
    expect(pageNeedsRewrite(await loadPage(md, fm()), 'frontmatter')).toBe(
      false
    );
  });
});

describe('a default title follows a renamed file', () => {
  it('in every storage mode', async () => {
    for (const loc of [fm(), side(), single()]) {
      const oldMd = path.join(dir, loc.storage, 'old-name.md');
      const newMd = path.join(dir, loc.storage, 'new-name.md');
      await fsp.mkdir(path.dirname(oldMd), { recursive: true });
      await savePage(oldMd, metaFor(oldMd, 'Body\n'), 'Body\n', {
        ...loc,
        stampSyncHash: true,
      });
      expect((await loadPage(oldMd, loc)).meta.title).toBe('Old Name');

      await fsp.rename(oldMd, newMd);
      await relocateMetadata({
        oldPath: oldMd,
        newPath: newMd,
        isDir: false,
        oldRoot: loc.root,
        newLoc: loc,
      });
      const loaded = await loadPage(newMd, loc);
      expect(loaded.meta.id).toBe(5);
      expect(loaded.meta.title).toBe('New Name'); // computed, not stored
    }
  });
});

describe('renameSidecar', () => {
  it('follows the .md to its new path', async () => {
    const oldMd = path.join(dir, 'a.md');
    const newMd = path.join(dir, 'sub', 'b.md');
    await fsp.mkdir(path.join(dir, 'sub'));
    await savePage(oldMd, metaFor(oldMd, 'Body\n'), 'Body\n', {
      ...side(),
      stampSyncHash: true,
    });

    expect(await renameSidecar(oldMd, newMd)).toBe(true);
    expect(await exists(sidecarPathFor(oldMd))).toBe(false);
    expect(await exists(sidecarPathFor(newMd))).toBe(true);
    expect(await renameSidecar(oldMd, newMd)).toBe(false); // nothing left to move
  });
});

describe('relocateMetadata — single-file', () => {
  const seed = async (rel: string) => {
    const md = path.join(dir, rel);
    await fsp.mkdir(path.dirname(md), { recursive: true });
    await savePage(md, metaFor(md, 'Body\n'), 'Body\n', {
      ...single(),
      stampSyncHash: true,
    });
    return md;
  };
  const keys = async () =>
    Object.keys((await readJson(centralPathFor(dir))).pages);

  it('re-keys a renamed file (and is idempotent)', async () => {
    const oldMd = await seed('a.md');
    const newMd = path.join(dir, 'sub', 'b.md');
    await fsp.mkdir(path.dirname(newMd));
    await fsp.rename(oldMd, newMd);

    const args = {
      oldPath: oldMd,
      newPath: newMd,
      isDir: false,
      oldRoot: dir,
      newLoc: single(),
    };
    await relocateMetadata(args);
    expect(await keys()).toEqual(['sub/b.md']);
    expect((await loadPage(newMd, single())).meta.id).toBe(5);

    await relocateMetadata(args); // the event handler + an explicit call may both run
    expect(await keys()).toEqual(['sub/b.md']);
  });

  it('re-keys every page under a renamed folder, leaving siblings alone', async () => {
    await seed('guide/one.md');
    await seed('guide/deep/two.md');
    await seed('other/three.md');
    await fsp.rename(path.join(dir, 'guide'), path.join(dir, 'manual'));

    await relocateMetadata({
      oldPath: path.join(dir, 'guide'),
      newPath: path.join(dir, 'manual'),
      isDir: true,
      oldRoot: dir,
      newLoc: single(),
    });
    expect(await keys()).toEqual([
      'manual/deep/two.md',
      'manual/one.md',
      'other/three.md',
    ]);
  });

  it('does not confuse a folder with a same-prefixed sibling', async () => {
    await seed('guide/one.md');
    await seed('guide-old/two.md');
    await fsp.rename(path.join(dir, 'guide'), path.join(dir, 'manual'));
    await relocateMetadata({
      oldPath: path.join(dir, 'guide'),
      newPath: path.join(dir, 'manual'),
      isDir: true,
      oldRoot: dir,
      newLoc: single(),
    });
    expect(await keys()).toEqual(['guide-old/two.md', 'manual/one.md']);
  });

  it('moves an entry between two sync roots', async () => {
    const rootB = path.join(dir, 'B');
    const rootA = path.join(dir, 'A');
    await fsp.mkdir(rootA);
    await fsp.mkdir(rootB);
    const locA: MetaLocation = { storage: 'single-file', root: rootA };
    const locB: MetaLocation = { storage: 'single-file', root: rootB };
    const oldMd = path.join(rootA, 'x.md');
    await savePage(oldMd, metaFor(oldMd, 'Body\n'), 'Body\n', {
      ...locA,
      stampSyncHash: true,
    });
    const newMd = path.join(rootB, 'x.md');
    await fsp.rename(oldMd, newMd);

    await relocateMetadata({
      oldPath: oldMd,
      newPath: newMd,
      isDir: false,
      oldRoot: rootA,
      newLoc: locB,
    });
    expect(await exists(centralPathFor(rootA))).toBe(false); // emptied
    expect((await loadPage(newMd, locB)).meta.id).toBe(5);
  });

  it('carries the entry into the destination mode when it is not single-file', async () => {
    const oldMd = await seed('x.md');
    const newMd = path.join(dir, 'moved.md');
    await fsp.rename(oldMd, newMd);
    await relocateMetadata({
      oldPath: oldMd,
      newPath: newMd,
      isDir: false,
      oldRoot: dir,
      newLoc: fm(),
    });
    expect(await exists(centralPathFor(dir))).toBe(false);
    const loaded = await loadPage(newMd, fm());
    expect(loaded.metaSource).toBe('frontmatter');
    expect(loaded.meta.id).toBe(5);
    expect(loaded.meta.title).toBe('Moved');
  });

  it('carries a whole folder out of single-file storage', async () => {
    await seed('guide/one.md');
    await seed('guide/two.md');
    const newDir = path.join(dir, 'out');
    await fsp.rename(path.join(dir, 'guide'), newDir);
    await relocateMetadata({
      oldPath: path.join(dir, 'guide'),
      newPath: newDir,
      isDir: true,
      oldRoot: dir,
      newLoc: side(),
    });
    for (const n of ['one.md', 'two.md']) {
      const loaded = await loadPage(path.join(newDir, n), side());
      expect(loaded.metaSource).toBe('sidecar');
      expect(loaded.meta.id).toBe(5);
    }
    expect(await exists(centralPathFor(dir))).toBe(false);
  });

  it('a sidecar page dropped into a single-file folder migrates on the next save', async () => {
    const oldMd = path.join(dir, 'x.md');
    await savePage(oldMd, metaFor(oldMd, 'Body\n'), 'Body\n', {
      ...side(),
      stampSyncHash: true,
    });
    const newMd = path.join(dir, 'sub', 'x.md');
    await fsp.mkdir(path.dirname(newMd));
    await fsp.rename(oldMd, newMd);
    await relocateMetadata({
      oldPath: oldMd,
      newPath: newMd,
      isDir: false,
      oldRoot: dir,
      newLoc: single(),
    });
    const loaded = await loadPage(newMd, single());
    expect(loaded.meta.id).toBe(5);
    expect(pageNeedsRewrite(loaded, 'single-file')).toBe(true);
  });
});

describe('pruneCentralOrphans', () => {
  it('drops entries whose page file is gone, scoped to the folder', async () => {
    for (const rel of ['a/keep.md', 'a/gone.md', 'b/gone.md']) {
      const md = path.join(dir, rel);
      await fsp.mkdir(path.dirname(md), { recursive: true });
      await savePage(md, metaFor(md, 'x\n'), 'x\n', {
        ...single(),
        stampSyncHash: true,
      });
    }
    await fsp.rm(path.join(dir, 'a', 'gone.md'));
    await fsp.rm(path.join(dir, 'b', 'gone.md'));

    expect(await pruneCentralOrphans(dir, path.join(dir, 'a'))).toBe(1);
    expect(Object.keys((await readJson(centralPathFor(dir))).pages)).toEqual([
      'a/keep.md',
      'b/gone.md', // outside the folder asked about
    ]);
    expect(await pruneCentralOrphans(dir, dir)).toBe(1);
  });
});

it('the central filename is a dotfile so folder walks skip it', () => {
  expect(CENTRAL_FILENAME.startsWith('.')).toBe(true);
});
