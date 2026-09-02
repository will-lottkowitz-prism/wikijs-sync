import * as path from 'path';

// Pure path <-> wiki-page mapping and gitignore-style glob matching. No VS Code
// API, so it is unit-testable on its own (see pathmap.test.ts).

export interface PathContext {
  /** Absolute path of the folder that maps to `wikiPath`. */
  root: string;
  /** Wiki path prefix `root` maps to. '' = wiki root. No leading/trailing slash. */
  wikiPath: string;
}

export interface MatchContext extends PathContext {
  /** Whitelist globs (undefined/empty = allow everything not excluded). */
  include?: string[];
  /** Ignorelist globs. */
  exclude: string[];
}

const toPosix = (p: string): string => p.split(path.sep).join('/');

/** Strip leading/trailing slashes and surrounding whitespace. */
export const normalizeWikiPath = (p: string | undefined): string =>
  (p ?? '').trim().replace(/^\/+|\/+$/g, '');

/**
 * Wiki page path for a local `.md` file inside `ctx`. A top-level `index.md`
 * maps to the context's `wikiPath` itself (the "section landing page").
 */
export const pagePathForFile = (ctx: PathContext, filePath: string): string => {
  const relPosix = toPosix(
    path.relative(ctx.root, filePath).replace(/\.md$/i, '')
  );
  if (relPosix === 'index' && ctx.wikiPath) {
    return ctx.wikiPath;
  }
  return [ctx.wikiPath, relPosix].filter(Boolean).join('/');
};

/**
 * Local `.md` file path for a wiki page path, within `ctx`. A page at exactly
 * `ctx.wikiPath` lands in `index.md` at the context root.
 */
export const fileForPagePath = (ctx: PathContext, pagePath: string): string => {
  let rel = pagePath;
  if (ctx.wikiPath) {
    if (pagePath === ctx.wikiPath) {
      rel = 'index';
    } else if (pagePath.startsWith(`${ctx.wikiPath}/`)) {
      rel = pagePath.slice(ctx.wikiPath.length + 1);
    }
  }
  return path.join(ctx.root, `${rel}.md`);
};

/** Server-absolute asset link for a local non-`.md` file inside `ctx`. */
export const assetLinkForFile = (
  ctx: PathContext,
  filePath: string
): string => {
  const rel = toPosix(path.relative(ctx.root, filePath));
  return '/' + [ctx.wikiPath, rel].filter(Boolean).join('/');
};

/** Wiki-relative directory (for the asset folder tree) of a local non-`.md` file. */
export const assetDirForFile = (ctx: PathContext, filePath: string): string => {
  const relDir = path.dirname(path.relative(ctx.root, filePath));
  const relDirPosix = relDir === '.' ? '' : toPosix(relDir);
  return [ctx.wikiPath, relDirPosix].filter(Boolean).join('/');
};

// --- glob matching -----------------------------------------------------------

const globToRegExp = (glob: string): RegExp => {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        if (glob[i + 2] === '/') {
          re += '(?:[^/]*/)*';
          i += 2;
        } else {
          re += '.*';
          i += 1;
        }
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if ('\\^$.|+()[]{}'.includes(c)) {
      re += '\\' + c;
    } else {
      re += c;
    }
  }
  return new RegExp(`^${re}$`);
};

const globCache = new Map<string, RegExp>();

export const matchGlob = (glob: string, relPosix: string): boolean => {
  let re = globCache.get(glob);
  if (!re) {
    re = globToRegExp(glob);
    globCache.set(glob, re);
  }
  if (re.test(relPosix)) return true;
  // a bare `dir/**` should also match `dir` itself and `dir/` prefixes
  if (
    glob.endsWith('/**') &&
    (relPosix === glob.slice(0, -3) || relPosix.startsWith(glob.slice(0, -2)))
  ) {
    return true;
  }
  return false;
};

/** Whether a file (anywhere under `ctx.root`) should sync, per include/exclude. */
export const fileMatchesContext = (
  ctx: MatchContext,
  filePath: string
): boolean => {
  const relPosix = toPosix(path.relative(ctx.root, filePath));
  if (relPosix.startsWith('..')) return false;
  for (const g of ctx.exclude) {
    if (matchGlob(g, relPosix)) return false;
  }
  if (ctx.include && ctx.include.length > 0) {
    return ctx.include.some((g) => matchGlob(g, relPosix));
  }
  return true;
};
