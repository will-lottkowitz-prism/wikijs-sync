import { describe, it, expect } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {
  followFolderRenames,
  renameFileToServerName,
  serverAssetDir,
} from './assetRename';

const withTmp = async (fn: (dir: string) => Promise<void>) => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'wsync-asset-'));
  try {
    await fn(tmp);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
};

describe('serverAssetDir', () => {
  it('slugifies every segment', () => {
    expect(serverAssetDir(path.join('My Images', 'Sub.Dir'))).toBe(
      path.join('my-images', 'sub-dir')
    );
  });
  it('keeps a segment that would slug to nothing, and the root', () => {
    expect(serverAssetDir('...')).toBe('...');
    expect(serverAssetDir('')).toBe('');
  });
});

describe('followFolderRenames', () => {
  it('returns the path unchanged when it exists', async () => {
    await withTmp(async (root) => {
      await fs.mkdir(path.join(root, 'Images'));
      const f = path.join(root, 'Images', 'a.png');
      await fs.writeFile(f, 'x');
      expect(await followFolderRenames(root, f)).toBe(f);
    });
  });
  it('follows a folder that was renamed to its server form since the path was collected', async () => {
    await withTmp(async (root) => {
      await fs.mkdir(path.join(root, 'my-images'));
      await fs.writeFile(path.join(root, 'my-images', 'b.png'), 'x');
      const stale = path.join(root, 'My Images', 'b.png');
      expect(await followFolderRenames(root, stale)).toBe(
        path.join(root, 'my-images', 'b.png')
      );
    });
  });
  it('returns the original path when the file is nowhere', async () => {
    await withTmp(async (root) => {
      const gone = path.join(root, 'Nope', 'c.png');
      expect(await followFolderRenames(root, gone)).toBe(gone);
    });
  });
});

describe('renameFileToServerName', () => {
  it('renames to lowercase with spaces as underscores', async () => {
    await withTmp(async (root) => {
      const f = path.join(root, 'Foo Bar.PNG');
      await fs.writeFile(f, 'x');
      const r = await renameFileToServerName(f);
      expect(r).toEqual({
        path: path.join(root, 'foo_bar.png'),
        renamed: true,
      });
      expect(await fs.readFile(r.path, 'utf8')).toBe('x');
    });
  });
  it('leaves a matching name alone', async () => {
    await withTmp(async (root) => {
      const f = path.join(root, 'ok.png');
      await fs.writeFile(f, 'x');
      expect(await renameFileToServerName(f)).toEqual({
        path: f,
        renamed: false,
      });
    });
  });
  it('does not overwrite a different file already holding the target name', async () => {
    await withTmp(async (root) => {
      const f = path.join(root, 'A B.png');
      const other = path.join(root, 'a_b.png');
      await fs.writeFile(f, 'mine');
      await fs.writeFile(other, 'theirs');
      expect(await renameFileToServerName(f)).toEqual({
        path: f,
        renamed: false,
      });
      expect(await fs.readFile(other, 'utf8')).toBe('theirs');
      expect(await fs.readFile(f, 'utf8')).toBe('mine');
    });
  });
});
