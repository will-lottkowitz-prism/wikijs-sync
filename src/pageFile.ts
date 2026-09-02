import * as crypto from 'crypto';
import * as path from 'path';

export interface PageMeta {
  id?: number;
  title: string;
  description: string;
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

const FRONT_MATTER_RE = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/;

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

export function serializePageFile(meta: PageMeta, content: string): string {
  const lines = [
    '---',
    `id: ${meta.id ?? ''}`,
    `title: ${yamlStr(meta.title)}`,
    `description: ${yamlStr(meta.description)}`,
    `path: ${meta.path}`,
    `editor: ${meta.editor}`,
    `locale: ${meta.locale}`,
    `isPublished: ${meta.isPublished}`,
    `isPrivate: ${meta.isPrivate}`,
    `tags: [${meta.tags.map(yamlStr).join(', ')}]`,
  ];
  if (meta.updatedAt) {
    lines.push(`updatedAt: ${meta.updatedAt}`);
  }
  if (meta.syncHash) {
    lines.push(`syncHash: ${meta.syncHash}`);
  }
  lines.push('---', '');
  return lines.join('\n') + content;
}

// A stable fingerprint of the parts of a page that get pushed to Wiki.js — the
// body plus the metadata fields the server stores. Folder sync uses it to tell
// "unchanged since the last sync" from "edited locally" without fetching and
// diffing the remote copy. Deliberately excludes id, updatedAt and syncHash
// itself (bookkeeping, not page content).
export function pageDigest(meta: PageMeta, content: string): string {
  const canonical = JSON.stringify({
    title: meta.title,
    description: meta.description,
    path: meta.path,
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
export function serializeSynced(meta: PageMeta, content: string): string {
  return serializePageFile(
    { ...meta, syncHash: pageDigest(meta, content) },
    content
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

export function parsePageFile(text: string): {
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

  const raw: Record<string, string> = {};
  for (const line of front.split('\n')) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    raw[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }

  let tags: string[] = [];
  const tagsRaw = (raw.tags ?? '[]').trim();
  if (tagsRaw.startsWith('[') && tagsRaw.endsWith(']')) {
    const inner = tagsRaw.slice(1, -1).trim();
    if (inner) {
      tags = inner.split(',').map((t) => yamlUnstr(t));
    }
  }

  const meta: PageMeta = {
    id: raw.id ? Number(raw.id) : undefined,
    title: yamlUnstr(raw.title ?? ''),
    description: yamlUnstr(raw.description ?? ''),
    path: raw.path ?? '',
    editor: raw.editor || 'markdown',
    locale: raw.locale || 'en',
    isPublished: (raw.isPublished ?? 'true').toLowerCase() === 'true',
    isPrivate: (raw.isPrivate ?? 'false').toLowerCase() === 'true',
    tags,
    updatedAt: raw.updatedAt || undefined,
    syncHash: raw.syncHash || undefined,
  };
  return { meta, content };
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
