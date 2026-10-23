// Local-side path handling for assets under `lowercasePaths`: no VS Code API, so
// it is unit-testable on its own (see assetRename.unit.test.ts).
import * as fs from 'fs/promises';
import * as path from 'path';
import { serverAssetName, slugifyFolderSegment } from './pathmap';

// Wiki.js asset folders are slugs (lowercase, spaces -> `-`). A segment that
// would slug to nothing is kept.
export function serverAssetDir(relDir: string): string {
  return relDir
    .split(path.sep)
    .map((seg) => slugifyFolderSegment(seg) || seg)
    .join(path.sep);
}

// Renaming a folder moves its other files, so a path collected before an earlier
// rename (a page or asset in the same folder) can be stale: falls back to the
// same path with its folders in server form, else returns `filePath` unchanged.
export async function followFolderRenames(
  root: string,
  filePath: string
): Promise<string> {
  try {
    await fs.lstat(filePath);
    return filePath;
  } catch {
    const moved = path.join(
      root,
      serverAssetDir(path.relative(root, path.dirname(filePath))),
      path.basename(filePath)
    );
    try {
      await fs.lstat(moved);
      return moved;
    } catch {
      return filePath;
    }
  }
}

// Renames the file itself to `serverAssetName`. Returns the resulting path and
// whether a rename happened; left alone when the name already matches or another
// file holds the target name.
export async function renameFileToServerName(
  filePath: string
): Promise<{ path: string; renamed: boolean }> {
  const name = path.basename(filePath);
  const newName = serverAssetName(name);
  if (name === newName) return { path: filePath, renamed: false };

  const newPath = path.join(path.dirname(filePath), newName);
  try {
    // A case-only rename "exists" on a case-insensitive fs; it is the file itself.
    const [a, b] = await Promise.all([fs.lstat(filePath), fs.lstat(newPath)]);
    if (a.ino !== b.ino || a.dev !== b.dev) {
      return { path: filePath, renamed: false };
    }
  } catch {
    // target absent: free to rename
  }
  await fs.rename(filePath, newPath);
  return { path: newPath, renamed: true };
}
