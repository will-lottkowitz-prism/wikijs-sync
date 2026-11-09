import * as fs from 'fs';
import * as path from 'path';

// Pure path <-> wiki-page mapping and gitignore-style glob matching. No VS Code
// API, so it is unit-testable on its own (see pathmap.test.ts).

export interface PathContext {
  /** Absolute path of the folder that maps to `wikiPath`. */
  root: string;
  /** Wiki path prefix `root` maps to. '' = wiki root. No leading/trailing slash. */
  wikiPath: string;
  /** Lowercase every page path (so it agrees with Wiki.js's lowercase asset folders). */
  lowercasePaths?: boolean;
  /** File-existence probe (tests inject one). Default: `fs.existsSync`. */
  exists?: (absPath: string) => boolean;
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

// Folder landing pages. `<folder>/home.md` and `<folder>/index.md` both map to
// the page at `<folder>` itself (so `/services/vpn` resolves). `home` wins when
// both exist: `index.md` then keeps its own `<folder>/index` page.
const LANDING_NAMES = ['home', 'index'];

const existsIn = (ctx: PathContext, p: string): boolean =>
  (ctx.exists ?? fs.existsSync)(p);

/**
 * Wiki page path for a local `.md` file inside `ctx`. `index.md` / `home.md`
 * (home preferred) map to their folder's page; at the context root with a
 * `wikiPath` that is `wikiPath` itself, with no `wikiPath` they stay `index` /
 * `home`. The portion derived from the file's location is sanitized to a
 * Wiki.js-legal form; `ctx.wikiPath` is author-controlled and prepended as
 * given (only the combined first segment gets the reserved-word guard).
 */
export const pagePathForFile = (ctx: PathContext, filePath: string): string => {
  let relPosix = toPosix(
    path.relative(ctx.root, filePath).replace(/\.md$/i, '')
  );
  const segs = relPosix.split('/');
  const base = segs[segs.length - 1];
  if (LANDING_NAMES.includes(base.toLowerCase())) {
    const dir = segs.slice(0, -1).join('/');
    const homeBeatsIndex =
      base.toLowerCase() === 'index' &&
      existsIn(ctx, path.join(ctx.root, ...segs.slice(0, -1), 'home.md'));
    if (!homeBeatsIndex) {
      if (dir === '') {
        if (ctx.wikiPath) return ctx.wikiPath;
      } else {
        relPosix = dir;
      }
    }
  }
  const joined = [ctx.wikiPath, sanitizeSegments(relPosix)]
    .filter(Boolean)
    .join('/');
  return guardFirstSegment(ctx.lowercasePaths ? joined.toLowerCase() : joined);
};

/**
 * Local `.md` file path for a wiki page path, within `ctx`. Prefers an existing
 * `<page>/home.md`, then `<page>/index.md`, then `<page>.md`; a page whose
 * folder exists locally (and has no `<page>.md`) lands in `<page>/index.md`. The
 * page at exactly `ctx.wikiPath` is the context root's `home.md` if present,
 * else `index.md`.
 */
export const fileForPagePath = (
  ctx: PathContext,
  rawPagePath: string
): string => {
  const lower = ctx.lowercasePaths;
  const pagePath = lower ? rawPagePath.toLowerCase() : rawPagePath;
  const wikiPath = lower ? ctx.wikiPath.toLowerCase() : ctx.wikiPath;
  let rel = pagePath;
  if (wikiPath) {
    if (pagePath === wikiPath) {
      rel = '';
    } else if (pagePath.startsWith(`${wikiPath}/`)) {
      rel = pagePath.slice(wikiPath.length + 1);
    }
  }
  const dir = path.join(ctx.root, rel);
  if (existsIn(ctx, path.join(dir, 'home.md')))
    return path.join(dir, 'home.md');
  if (existsIn(ctx, path.join(dir, 'index.md')))
    return path.join(dir, 'index.md');
  if (rel === '') return path.join(ctx.root, 'index.md');
  const flat = `${dir}.md`;
  if (!existsIn(ctx, flat) && existsIn(ctx, dir))
    return path.join(dir, 'index.md');
  return flat;
};

/**
 * The filename Wiki.js stores an uploaded asset under: lowercased, whitespace
 * runs turned into `_` (`FLEX Thesis.pdf` -> `flex_thesis.pdf`). Used to match a
 * local file to its server copy, and as the name a local file is renamed to
 * under `lowercasePaths`.
 */
export const serverAssetName = (filename: string): string =>
  filename.toLowerCase().replace(/\s+/g, '_');

/** Server-absolute asset link for a local non-`.md` file inside `ctx`. */
export const assetLinkForFile = (ctx: PathContext, filePath: string): string =>
  '/' +
  [assetDirForFile(ctx, filePath), serverAssetName(path.basename(filePath))]
    .filter(Boolean)
    .join('/');

/**
 * Wiki.js asset folders are addressed by slug and are lowercase-only, so folder
 * segments are slugified when created. Filenames are normalised by the server
 * too (see `serverAssetName`).
 */
export const slugifyFolderSegment = (segment: string): string =>
  segment
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');

/**
 * Wiki-relative directory (for the asset folder tree) of a local non-`.md` file,
 * as the slugified folder path Wiki.js actually holds (and serves) it under.
 */
export const assetDirForFile = (ctx: PathContext, filePath: string): string => {
  const relDir = path.dirname(path.relative(ctx.root, filePath));
  const relDirPosix = relDir === '.' ? '' : toPosix(relDir);
  return [ctx.wikiPath, relDirPosix]
    .filter(Boolean)
    .join('/')
    .split('/')
    .map(slugifyFolderSegment)
    .filter(Boolean)
    .join('/');
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
