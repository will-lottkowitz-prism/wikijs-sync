import * as path from 'path';
import * as fsp from 'fs/promises';
import { MetaFields, orderFields, sanitizeFields } from './pageFile';

// 'single-file' metadata storage: one `.wikijs.metadata.json` at the sync root
// (the folder holding `.wikisync.json`, or the legacy content dir) carrying the
// metadata for every page beneath it, keyed by the page's posix path relative to
// that root:
//
//   { "version": 1, "pages": { "guide/intro.md": { "id": 12, "syncHash": "…" } } }
//
// Entries hold only non-default fields (see `nonDefaultFields`), so a page whose
// title is just its heading costs `id` + `updatedAt` + `syncHash` and no more.
// Commit the file: it holds every page's id.

export const CENTRAL_FILENAME = '.wikijs.metadata.json';

const NOTE =
  'Wiki.js Sync page metadata for every page under this folder. Managed by the ' +
  'extension; keys are page file paths relative to this file.';

export const centralPathFor = (root: string): string =>
  path.join(root, CENTRAL_FILENAME);

/** True for the central metadata file's own name, so walks never treat it as content. */
export const isCentralName = (name: string): boolean =>
  name === CENTRAL_FILENAME;

const toPosix = (p: string): string => p.split(path.sep).join('/');

/** `filePath` relative to `root`, posix-style; undefined when it is outside `root`. */
export function centralKey(root: string, filePath: string): string | undefined {
  const rel = path.relative(root, filePath);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    return undefined;
  }
  return toPosix(rel);
}

export interface CentralFile {
  version: 1;
  pages: Record<string, MetaFields>;
}

function serializeCentral(data: CentralFile): string {
  const pages: Record<string, MetaFields> = {};
  for (const key of Object.keys(data.pages).sort()) {
    pages[key] = orderFields(data.pages[key]);
  }
  return JSON.stringify({ _note: NOTE, version: 1, pages }, null, 2) + '\n';
}

function parseCentral(text: string, jsonPath: string): CentralFile {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err: any) {
    throw new Error(
      `${jsonPath} is not valid JSON (${err?.message ?? err}). Fix or delete it — ` +
        `Wiki.js Sync won't overwrite it while it can't be read.`
    );
  }
  const pages: Record<string, MetaFields> = {};
  const rawPages = (raw as { pages?: unknown } | null)?.pages;
  if (rawPages && typeof rawPages === 'object' && !Array.isArray(rawPages)) {
    for (const [key, value] of Object.entries(rawPages)) {
      pages[key] = sanitizeFields(value);
    }
  }
  return { version: 1, pages };
}

// -- cached read ---------------------------------------------------------------
// A folder sync loads every page, so re-parsing the file per page would be
// quadratic. Cache the parse keyed on the file's mtime + size.

interface CacheEntry {
  mtimeMs: number;
  size: number;
  text: string;
  data: CentralFile;
}
const cache = new Map<string, CacheEntry>();

async function readRaw(root: string): Promise<CacheEntry | undefined> {
  const jsonPath = centralPathFor(root);
  let st;
  try {
    st = await fsp.stat(jsonPath);
  } catch {
    cache.delete(jsonPath);
    return undefined;
  }
  const hit = cache.get(jsonPath);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit;

  const text = (await fsp.readFile(jsonPath, 'utf8')).replace(/^﻿/, '');
  const entry: CacheEntry = {
    mtimeMs: st.mtimeMs,
    size: st.size,
    text,
    data: parseCentral(text, jsonPath),
  };
  cache.set(jsonPath, entry);
  return entry;
}

/** The stored fields for `filePath`, or undefined (no file, or no entry). Throws if the file is invalid. */
export async function readCentralEntry(
  root: string,
  filePath: string
): Promise<MetaFields | undefined> {
  const key = centralKey(root, filePath);
  if (key === undefined) return undefined;
  const entry = await readRaw(root);
  const fields = entry?.data.pages[key];
  return fields ? { ...fields } : undefined;
}

// -- serialized read-modify-write ---------------------------------------------
// Uploads on save, a folder sync and the rename handler can all touch the file
// at once; chain every mutation per file so none is lost.

const locks = new Map<string, Promise<unknown>>();

function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prior = locks.get(key) ?? Promise.resolve();
  const run = prior.then(fn, fn);
  locks.set(
    key,
    run.then(
      () => undefined,
      () => undefined
    )
  );
  return run;
}

/**
 * Apply `mutate` to the page map and persist it. Writes nothing when the result
 * is identical to what is on disk, creates the file only when there is something
 * to store, and deletes it when the last entry goes.
 */
export function updateCentral(
  root: string,
  mutate: (pages: Record<string, MetaFields>) => void
): Promise<void> {
  const jsonPath = centralPathFor(root);
  return withLock(jsonPath, async () => {
    const current = await readRaw(root);
    const data: CentralFile = current
      ? { version: 1, pages: JSON.parse(JSON.stringify(current.data.pages)) }
      : { version: 1, pages: {} };
    mutate(data.pages);

    if (Object.keys(data.pages).length === 0) {
      if (current) {
        await fsp.unlink(jsonPath).catch(() => undefined);
        cache.delete(jsonPath);
      }
      return;
    }

    const text = serializeCentral(data);
    if (current && current.text === text) return;

    // Write-then-rename so a crash can't leave a half-written (unparseable) file.
    const tmp = `${jsonPath}.${process.pid}.tmp`;
    await fsp.writeFile(tmp, text, 'utf8');
    await fsp.rename(tmp, jsonPath);
    const st = await fsp.stat(jsonPath);
    cache.set(jsonPath, {
      mtimeMs: st.mtimeMs,
      size: st.size,
      text,
      data: parseCentral(text, jsonPath),
    });
  });
}

export async function writeCentralEntry(
  root: string,
  filePath: string,
  fields: MetaFields
): Promise<void> {
  const key = centralKey(root, filePath);
  if (key === undefined) {
    throw new Error(
      `${filePath} is outside ${root}, so it can't be recorded in ${CENTRAL_FILENAME}.`
    );
  }
  await updateCentral(root, (pages) => {
    pages[key] = orderFields(fields);
  });
}

/** Drop `filePath`'s entry, if there is one. Never creates the file. */
export async function removeCentralEntry(
  root: string,
  filePath: string
): Promise<void> {
  const key = centralKey(root, filePath);
  if (key === undefined) return;
  // Cheap pre-check outside the lock: the common case is "no such entry".
  if (!(await readRaw(root))?.data.pages[key]) return;
  await updateCentral(root, (pages) => {
    delete pages[key];
  });
}

export interface CentralMove {
  /** Key in the old file. */
  oldKey: string;
  /** Absolute path the page now lives at. */
  newFile: string;
  fields: MetaFields;
}

/**
 * The entries in `oldRoot`'s file that belonged to `oldPath` — the one page, or,
 * for a moved folder, every page beneath it — paired with where each now lives
 * under `newPath`. Read-only.
 */
export async function findCentralMoves(
  oldRoot: string,
  oldPath: string,
  newPath: string,
  isDir: boolean
): Promise<CentralMove[]> {
  const oldKey = centralKey(oldRoot, oldPath);
  if (oldKey === undefined) return [];
  const entry = await readRaw(oldRoot);
  if (!entry) return [];

  const moves: CentralMove[] = [];
  for (const [key, fields] of Object.entries(entry.data.pages)) {
    if (!isDir) {
      if (key === oldKey) moves.push({ oldKey: key, newFile: newPath, fields });
    } else if (key.startsWith(`${oldKey}/`)) {
      const rest = key.slice(oldKey.length + 1).split('/');
      moves.push({
        oldKey: key,
        newFile: path.join(newPath, ...rest),
        fields,
      });
    }
  }
  return moves;
}

/**
 * Remove entries under `folder` whose page file no longer exists. Returns how
 * many were dropped.
 */
export async function pruneCentralOrphans(
  root: string,
  folder: string
): Promise<number> {
  const rel = path.relative(root, folder);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return 0;
  const prefix = rel === '' ? '' : `${toPosix(rel)}/`;
  const entry = await readRaw(root);
  if (!entry) return 0;

  const orphans: string[] = [];
  for (const key of Object.keys(entry.data.pages)) {
    if (!key.startsWith(prefix)) continue;
    try {
      await fsp.access(path.join(root, ...key.split('/')));
    } catch {
      orphans.push(key);
    }
  }
  if (orphans.length === 0) return 0;
  await updateCentral(root, (pages) => {
    for (const key of orphans) delete pages[key];
  });
  return orphans.length;
}
