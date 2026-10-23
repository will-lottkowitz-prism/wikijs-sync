// Filesystem checks that need no VS Code API, so they are unit-testable on their
// own (see fsGuards.unit.test.ts).
import * as fs from 'fs/promises';
import * as path from 'path';

// The first folder between `root` and `filePath` that is a symlink, if any.
export async function symlinkedAncestor(
  root: string,
  filePath: string
): Promise<string | undefined> {
  const segs = path.relative(root, path.dirname(filePath)).split(path.sep);
  let cur = root;
  for (const seg of segs) {
    if (!seg || seg === '.') continue;
    cur = path.join(cur, seg);
    try {
      if ((await fs.lstat(cur)).isSymbolicLink()) return cur;
    } catch {
      return undefined;
    }
  }
  return undefined;
}
