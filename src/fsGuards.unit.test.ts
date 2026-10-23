import { describe, it, expect } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { symlinkedAncestor } from './fsGuards';

describe('symlinkedAncestor', () => {
  it('finds the first symlinked folder above a file, not a symlinked file', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'wsync-'));
    try {
      const real = path.join(tmp, 'elsewhere');
      const root = path.join(tmp, 'root');
      await fs.mkdir(real);
      await fs.mkdir(path.join(root, 'plain'), { recursive: true });
      await fs.writeFile(path.join(real, 'a.md'), 'x');
      await fs.writeFile(path.join(root, 'plain', 'b.md'), 'x');
      await fs.symlink(real, path.join(root, 'linked'));
      await fs.symlink(
        path.join(real, 'a.md'),
        path.join(root, 'plain', 'c.md')
      );

      expect(
        await symlinkedAncestor(root, path.join(root, 'linked', 'a.md'))
      ).toBe(path.join(root, 'linked'));
      expect(
        await symlinkedAncestor(root, path.join(root, 'plain', 'b.md'))
      ).toBeUndefined();
      expect(
        await symlinkedAncestor(root, path.join(root, 'plain', 'c.md'))
      ).toBeUndefined();
      expect(
        await symlinkedAncestor(root, path.join(root, 'top.md'))
      ).toBeUndefined();
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});
