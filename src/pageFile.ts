import * as crypto from 'crypto';
import * as path from 'path';

export interface PageMeta {
  id?: number;
  title: string;
  description: string;
  /**
   * Wiki.js page path. NOT stored in the front matter — it is derived from the
   * file's location relative to the reference point set by `.wikisync.json`
   * (see `pagePathForFile`). Callers populate it right after parsing; it is
   * carried here only because the upload API and `pageDigest` need it.
   */
  path: string;
  editor: string;
  locale: string;
  isPublished: boolean;
  isPrivate: boolean;
  tags: string[];
  updatedAt?: string;
  /** sha256 of the page as it stood at the last successful sync (see pageDigest). */
  syncHash?: string;
}

// Where a page's sync metadata is kept:
//  - 'frontmatter' (default): a `---` YAML block at the top of the `.md` file.
//  - 'sidecar': a hidden sibling file per page, leaving the `.md` as pure
//    Markdown so it stays clean when the same file is also published somewhere
//    other than the wiki.
//  - 'single-file': one `.wikijs.metadata.json` at the sync root holding the
//    metadata for every page beneath it (see `centralStore.ts`).
export type MetadataStorage = 'frontmatter' | 'sidecar' | 'single-file';

export const METADATA_STORAGE_MODES: readonly MetadataStorage[] = [
  'frontmatter',
  'sidecar',
  'single-file',
];

// A block that is either empty (`---` straight into `---`, which is what a page
// whose every field is default and has never synced serializes to) or holds at
// least one line.
const FRONT_MATTER_RE = /^---\n(?:---\n|([\s\S]*?)\n---\n)([\s\S]*)$/;

/** True when `text` opens with a `---` front-matter block. */
export function hasFrontMatter(text: string): boolean {
  return FRONT_MATTER_RE.test(text.replace(/\r\n/g, '\n'));
}

function yamlStr(value: string): string {
  const v = value ?? '';
  if (/[:#[\]{}",]|^\s|\s$|^$/.test(v)) {
    return JSON.stringify(v);
  }
  return v;
}

function yamlUnstr(value: string): string {
  const v = value.trim();
  if (v.startsWith('"') && v.endsWith('"')) {
    try {
      return JSON.parse(v);
    } catch {
      // fall through and return the raw trimmed value
    }
  }
  return v;
}

// -- default-omitting metadata --------------------------------------------
//
// Every storage mode writes only the fields that differ from what the extension
// would compute for the file anyway (`defaultMetaForFile`: title from the first
// `# Heading` or the filename, no description, `markdown`/`en`, published,
// public, no tags). A field that is at its default is simply absent, so it keeps
// following the file — rename a page's file and its default title moves with
// it, with nothing on disk to go stale. `id`, `updatedAt` and `syncHash` are
// bookkeeping with no default, so they are stored whenever they are known.

/** The stored (non-default) subset of a PageMeta, with `path` never included. */
export interface MetaFields {
  id?: number;
  title?: string;
  description?: string;
  editor?: string;
  locale?: string;
  isPublished?: boolean;
  isPrivate?: boolean;
  tags?: string[];
  updatedAt?: string;
  syncHash?: string;
}

const sameTags = (a: string[], b: string[]): boolean =>
  a.length === b.length && a.every((t, i) => t === b[i]);

/** The fields of `meta` that differ from `defaults`, in canonical key order. */
export function nonDefaultFields(
  meta: PageMeta,
  defaults: PageMeta
): MetaFields {
  const f: MetaFields = {};
  if (meta.id !== undefined) f.id = meta.id;
  if (meta.title !== defaults.title) f.title = meta.title;
  if (meta.description !== defaults.description)
    f.description = meta.description;
  if (meta.editor !== defaults.editor) f.editor = meta.editor;
  if (meta.locale !== defaults.locale) f.locale = meta.locale;
  if (meta.isPublished !== defaults.isPublished)
    f.isPublished = meta.isPublished;
  if (meta.isPrivate !== defaults.isPrivate) f.isPrivate = meta.isPrivate;
  if (!sameTags(meta.tags, defaults.tags)) f.tags = [...meta.tags];
  if (meta.updatedAt) f.updatedAt = meta.updatedAt;
  if (meta.syncHash) f.syncHash = meta.syncHash;
  return f;
}

/** Stored fields re-laid-out in canonical key order, for stable comparison. */
export function orderFields(f: MetaFields): MetaFields {
  const o: MetaFields = {};
  if (f.id !== undefined) o.id = f.id;
  if (f.title !== undefined) o.title = f.title;
  if (f.description !== undefined) o.description = f.description;
  if (f.editor !== undefined) o.editor = f.editor;
  if (f.locale !== undefined) o.locale = f.locale;
  if (f.isPublished !== undefined) o.isPublished = f.isPublished;
  if (f.isPrivate !== undefined) o.isPrivate = f.isPrivate;
  if (f.tags !== undefined) o.tags = f.tags;
  if (f.updatedAt !== undefined) o.updatedAt = f.updatedAt;
  if (f.syncHash !== undefined) o.syncHash = f.syncHash;
  return o;
}

export function sameFields(a: MetaFields, b: MetaFields): boolean {
  return JSON.stringify(orderFields(a)) === JSON.stringify(orderFields(b));
}

/** Coerce untrusted parsed JSON into MetaFields, dropping anything mistyped. */
export function sanitizeFields(raw: unknown): MetaFields {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const r = raw as Record<string, unknown>;
  const f: MetaFields = {};
  if (typeof r.id === 'number' && Number.isFinite(r.id)) f.id = r.id;
  if (typeof r.title === 'string') f.title = r.title;
  if (typeof r.description === 'string') f.description = r.description;
  if (typeof r.editor === 'string' && r.editor) f.editor = r.editor;
  if (typeof r.locale === 'string' && r.locale) f.locale = r.locale;
  if (typeof r.isPublished === 'boolean') f.isPublished = r.isPublished;
  if (typeof r.isPrivate === 'boolean') f.isPrivate = r.isPrivate;
  if (Array.isArray(r.tags) && r.tags.every((t) => typeof t === 'string'))
    f.tags = r.tags as string[];
  if (typeof r.updatedAt === 'string' && r.updatedAt) f.updatedAt = r.updatedAt;
  if (typeof r.syncHash === 'string' && r.syncHash) f.syncHash = r.syncHash;
  return orderFields(f);
}

/** A full PageMeta from stored fields, every absent field taking its default. */
export function metaFromFields(f: MetaFields, defaults: PageMeta): PageMeta {
  return {
    id: f.id,
    title: f.title ?? defaults.title,
    description: f.description ?? defaults.description,
    path: '',
    editor: f.editor ?? defaults.editor,
    locale: f.locale ?? defaults.locale,
    isPublished: f.isPublished ?? defaults.isPublished,
    isPrivate: f.isPrivate ?? defaults.isPrivate,
    tags: f.tags ? [...f.tags] : [...defaults.tags],
    updatedAt: f.updatedAt,
    syncHash: f.syncHash,
  };
}

// The `key: value` metadata lines shared by the front-matter block and the
// sidecar file (see `sidecar.ts`). No `---` fences, no trailing newline. Only
// non-default fields are emitted.
export function serializeMetaLines(
  meta: PageMeta,
  defaults: PageMeta
): string[] {
  const f = nonDefaultFields(meta, defaults);
  const lines: string[] = [];
  if (f.id !== undefined) lines.push(`id: ${f.id}`);
  if (f.title !== undefined) lines.push(`title: ${yamlStr(f.title)}`);
  if (f.description !== undefined)
    lines.push(`description: ${yamlStr(f.description)}`);
  if (f.editor !== undefined) lines.push(`editor: ${f.editor}`);
  if (f.locale !== undefined) lines.push(`locale: ${f.locale}`);
  if (f.isPublished !== undefined) lines.push(`isPublished: ${f.isPublished}`);
  if (f.isPrivate !== undefined) lines.push(`isPrivate: ${f.isPrivate}`);
  if (f.tags !== undefined)
    lines.push(`tags: [${f.tags.map(yamlStr).join(', ')}]`);
  if (f.updatedAt !== undefined) lines.push(`updatedAt: ${f.updatedAt}`);
  if (f.syncHash !== undefined) lines.push(`syncHash: ${f.syncHash}`);
  return lines;
}

// `filePath` + `content` are what the defaults are computed from, so the same
// pair must be used when the file is read back (parsePageFile does).
export function serializePageFile(
  meta: PageMeta,
  content: string,
  filePath: string
): string {
  const lines = serializeMetaLines(meta, defaultMetaForFile(filePath, content));
  return ['---', ...lines, '---', ''].join('\n') + content;
}

// A stable fingerprint of the parts of a page that get pushed to Wiki.js — the
// body plus the metadata fields the server stores. Folder sync uses it to tell
// "unchanged since the last sync" from "edited locally" without fetching and
// diffing the remote copy. Deliberately excludes id, updatedAt and syncHash
// itself (bookkeeping, not page content), and `path` — a page's path is its
// location, not its content; a move is detected structurally (see syncFolder),
// not as a local edit.
export function pageDigest(meta: PageMeta, content: string): string {
  const canonical = JSON.stringify({
    title: meta.title,
    description: meta.description,
    editor: meta.editor,
    locale: meta.locale,
    isPublished: meta.isPublished,
    isPrivate: meta.isPrivate,
    tags: [...meta.tags].sort(),
    content,
  });
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

// Serialize a file that is now in sync with the server: stamps a fresh syncHash
// so the next folder sync recognises an untouched file and skips it. meta
// should already carry the server's latest updatedAt.
export function serializeSynced(
  meta: PageMeta,
  content: string,
  filePath: string
): string {
  return serializePageFile(
    { ...meta, syncHash: pageDigest(meta, content) },
    content,
    filePath
  );
}

// True when a file's on-disk text (CRLF-normalized, as everything here reads it)
// isn't the canonical serialization of what it parses to — a stale `path:` line
// left by an older version, reordered or unknown front-matter keys, extra blank
// lines, a missing trailing newline. Folder sync uses this to tidy an otherwise
// unchanged file in place: no network, no syncHash change (pageDigest already
// ignores everything this rewrites).
export function needsCanonicalRewrite(
  originalText: string,
  meta: PageMeta,
  content: string,
  filePath: string
): boolean {
  return (
    originalText.replace(/\r\n/g, '\n') !==
    serializePageFile(meta, content, filePath)
  );
}

// True when two Wiki.js timestamps denote the same instant. Wiki.js's GraphQL
// serializes timestamps inconsistently between `pages.list`, `pages.single` and
// mutation results (millisecond precision, timezone offset), so a raw string
// compare reports spurious changes and the sync never settles. Compare by
// parsed instant, with a fast path for an exact string match.
export function sameInstant(a?: string, b?: string): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  return !Number.isNaN(ta) && !Number.isNaN(tb) && ta === tb;
}

function toTitleCase(s: string): string {
  return s.replace(/\w\S*/g, (w) => w.charAt(0).toUpperCase() + w.slice(1));
}

function titleFromFilename(filePath: string): string {
  const base = path.basename(filePath, '.md');
  return toTitleCase(base.replace(/[-_]+/g, ' ').trim()) || base;
}

function titleFromHeading(content: string): string | undefined {
  return /^#\s+(.+?)\s*$/m.exec(content)?.[1];
}

// Front matter a fresh .md file gets on its first upload, so a page doesn't
// have to be hand-authored with a --- block before it can be pushed. Title
// prefers a leading "# Heading" in the content, falling back to the filename.
export function defaultMetaForFile(
  filePath: string,
  content: string
): PageMeta {
  return {
    title: titleFromHeading(content) ?? titleFromFilename(filePath),
    description: '',
    path: '',
    editor: 'markdown',
    locale: 'en',
    isPublished: true,
    isPrivate: false,
    tags: [],
  };
}

export function parsePageFile(
  text: string,
  filePath = ''
): {
  meta: PageMeta;
  content: string;
} {
  // Tolerate CRLF line endings (e.g. files created/edited on Windows) — the
  // front matter regex and per-line key:value parsing below assume bare \n.
  text = text.replace(/\r\n/g, '\n');

  const m = FRONT_MATTER_RE.exec(text);
  if (!m) {
    throw new Error(
      'Missing YAML front matter (expected a --- ... --- block at the top of the file).'
    );
  }
  const [, front, content] = m;
  return {
    meta: parseMetaFromLines(
      front ?? '',
      defaultMetaForFile(filePath, content)
    ),
    content,
  };
}

// Parse the `key: value` lines of a metadata block — a front-matter block or a
// sidecar file — into a PageMeta. Blank lines, `#` comment lines and lines with
// no `:` are ignored. A key that is absent takes its value from `defaults`.
// `path` is never read here: it is derived from the file's location by the
// caller, and a stale `path:` line left by an older version is dropped.
export function parseMetaFromLines(
  block: string,
  defaults: PageMeta
): PageMeta {
  const raw: Record<string, string> = {};
  for (const line of block.replace(/\r\n/g, '\n').split('\n')) {
    if (/^\s*#/.test(line)) continue;
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    raw[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }

  let tags = [...defaults.tags];
  if (raw.tags !== undefined) {
    tags = [];
    const tagsRaw = raw.tags.trim();
    if (tagsRaw.startsWith('[') && tagsRaw.endsWith(']')) {
      const inner = tagsRaw.slice(1, -1).trim();
      if (inner) {
        tags = inner.split(',').map((t) => yamlUnstr(t));
      }
    }
  }
  const bool = (v: string | undefined, dflt: boolean): boolean =>
    v === undefined || v === '' ? dflt : v.toLowerCase() === 'true';

  return {
    id: raw.id ? Number(raw.id) : undefined,
    title: raw.title !== undefined ? yamlUnstr(raw.title) : defaults.title,
    description:
      raw.description !== undefined
        ? yamlUnstr(raw.description)
        : defaults.description,
    path: '',
    editor: raw.editor || defaults.editor,
    locale: raw.locale || defaults.locale,
    isPublished: bool(raw.isPublished, defaults.isPublished),
    isPrivate: bool(raw.isPrivate, defaults.isPrivate),
    tags,
    updatedAt: raw.updatedAt || undefined,
    syncHash: raw.syncHash || undefined,
  };
}

// Like parsePageFile, but tolerates a file with no front matter block by
// synthesizing defaults instead of throwing — used by upload paths so a
// plain .md file can be pushed for the first time without hand-authoring
// metadata first. hadFrontMatter tells the caller whether that happened.
export function parsePageFileLoose(
  text: string,
  filePath: string
): { meta: PageMeta; content: string; hadFrontMatter: boolean } {
  const normalized = text.replace(/\r\n/g, '\n');
  if (FRONT_MATTER_RE.test(normalized)) {
    const { meta, content } = parsePageFile(text);
    return { meta, content, hadFrontMatter: true };
  }
  return {
    meta: defaultMetaForFile(filePath, normalized),
    content: normalized,
    hadFrontMatter: false,
  };
}

// Local <-> wiki path mapping lives in config.ts now (it depends on the
// resolved SyncContext, not a single global content dir).
