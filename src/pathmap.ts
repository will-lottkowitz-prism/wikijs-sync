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

// Wiki.js rejects a page path outright (server/models/pages.js createPage /
// movePage) only if it contains `.`, a space, `\` or `//`; server/helpers/
// page.js parsePath additionally *strips* the set `\x00-\x1f \x80-\x9f " \ | <
// > : * ?`. And the *first* segment can't be a single character, a locale code
// (`xx` / `xx-XX`), or one of a handful of reserved words. `sanitizeWikiPath`
// maps any local file/folder name to a path Wiki.js will accept, so callers
// never have to think about it.
//
// This is a *deny-list*, matched to Wiki.js exactly — an earlier allow-list
// (letters/digits/`_ ~ -` only) also mangled characters Wiki.js keeps verbatim
// (`+ # ( ) , ! ' & = @` …), which forced spurious local renames and, once a
// file had adopted a page id, orphaned that page on the next sync.
//   - `.` and whitespace → `-` (Wiki.js hard-rejects these)
//   - the parsePath "unsafe" set → removed (Wiki.js strips them, so dropping
//     them here keeps the local path equal to what the server stores)
//   - everything else (incl. accented letters, mixed case) is left untouched
const STRIP_IN_SEGMENT = /[\x00-\x1f\x80-\x9f"\\|<>:*?]/g;
const DASH_IN_SEGMENT = /[.\s]+/g;
const LOCALE_RE = /^[A-Za-z]{2}(-[A-Za-z]{2})?$/;
// From Wiki.js: client/components/common/page-selector.vue + data.reservedPaths.
const RESERVED_FIRST = new Set([
  'login',
  'logout',
  'register',
  'verify',
  'favicons',
  'fonts',
  'img',
  'js',
  'svg',
  'admin',
  'api',
  'assets',
  'graphql',
]);

const sanitizeSegment = (seg: string): string => {
  const s = seg
    .replace(STRIP_IN_SEGMENT, '')
    .replace(DASH_IN_SEGMENT, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');
  return s || '-';
};

/** Per-segment character sanitization; `//` collapses. No first-segment guard. */
const sanitizeSegments = (rawPath: string): string =>
  rawPath.split('/').filter(Boolean).map(sanitizeSegment).join('/');

// Wiki.js rejects a page whose *first* path segment is a single character, a
// locale code, or a reserved word — prefix it with `_` to get clear of that.
const guardFirstSegment = (p: string): string => {
  if (!p) return p;
  const segments = p.split('/');
  const first = segments[0];
  if (
    first.length <= 1 ||
    LOCALE_RE.test(first) ||
    RESERVED_FIRST.has(first.toLowerCase())
  ) {
    segments[0] = `_${first}`;
  }
  return segments.join('/');
};

/**
 * Map any `/`-joined path to a Wiki.js-legal page path: `.` and whitespace
 * become `-`, the parsePath "unsafe" set (`" \ | < > : * ?`, control chars) is
 * dropped, `//` collapses, and a first segment Wiki.js would reject (1 char /
 * locale code / reserved word) is prefixed with `_`. Anything Wiki.js accepts
 * as-is (`+ # ( ) ,` … accented letters, mixed case) is left untouched.
 * Idempotent: sanitizing an already-legal path is a no-op.
 */
export const sanitizeWikiPath = (rawPath: string): string =>
  guardFirstSegment(sanitizeSegments(rawPath));

/**
 * Wiki page path for a local `.md` file inside `ctx`. A top-level `index.md`
 * maps to the context's `wikiPath` itself (the "section landing page"). The
 * portion derived from the file's location is sanitized to a Wiki.js-legal form;
 * `ctx.wikiPath` is author-controlled and prepended as given (only the combined
 * first segment gets the reserved-word guard).
 */
export const pagePathForFile = (ctx: PathContext, filePath: string): string => {
  const relPosix = toPosix(
    path.relative(ctx.root, filePath).replace(/\.md$/i, '')
  );
  if (relPosix === 'index' && ctx.wikiPath) {
    return ctx.wikiPath;
  }
  const joined = [ctx.wikiPath, sanitizeSegments(relPosix)]
    .filter(Boolean)
    .join('/');
  return guardFirstSegment(joined);
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
