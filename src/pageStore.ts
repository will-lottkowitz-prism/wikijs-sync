import * as fsp from 'fs/promises';
import {
  MetaFields,
  MetadataStorage,
  PageMeta,
  defaultMetaForFile,
  hasFrontMatter,
  metaFromFields,
  nonDefaultFields,
  pageDigest,
  parsePageFile,
  parsePageFileLoose,
  sameFields,
  serializePageFile,
} from './pageFile';
import {
  parseSidecar,
  serializeSidecar,
  sidecarIsCanonical,
  sidecarPathFor,
} from './sidecar';
import {
  centralKey,
  findCentralMoves,
  readCentralEntry,
  removeCentralEntry,
  updateCentral,
  writeCentralEntry,
} from './centralStore';

// Storage-mode-aware read/write for a local page file. Callers work with a
// `{ meta, content }` pair and never touch the front-matter block, the sidecar
// or the central metadata file directly.
//
// Every mode stores only the fields that differ from `defaultMetaForFile` (see
// `pageFile.ts`), so a default-valued field follows its file for free.

/** Which mode a page's metadata is stored in, and (for 'single-file') where the file lives. */
export interface MetaLocation {
  storage: MetadataStorage;
  /** The sync root — the folder that holds `.wikijs.metadata.json`. */
  root: string;
}

export type MetaSource = 'frontmatter' | 'sidecar' | 'single-file' | 'none';

export interface LoadedPage {
  filePath: string;
  meta: PageMeta;
  content: string;
  /** Metadata was found somewhere (front matter, sidecar or central file), not synthesized. */
  hadFrontMatter: boolean;
  metaSource: MetaSource;
  /** The `.md` text as read (CRLF-normalized). */
  mdText: string;
  /** The sidecar text as read, when a sidecar file was present. */
  sidecarText?: string;
  /** This page's entry in the central metadata file, when it has one. */
  centralFields?: MetaFields;
}

const norm = (s: string): string => s.replace(/\r\n/g, '\n');

// The `.md` minus any front-matter block that is still on it.
function stripFrontMatter(mdText: string, filePath: string): string {
  try {
    return parsePageFile(mdText, filePath).content;
  } catch {
    return mdText; // no front-matter block — the whole file is the body
  }
}

// Read a page's metadata from wherever it is. The location's own mode is
// consulted first; any other source that is present still loads, so a folder
// whose mode has just been switched keeps its ids until each file is migrated.
export async function loadPage(
  filePath: string,
  loc: MetaLocation
): Promise<LoadedPage> {
  const mdText = norm(await fsp.readFile(filePath, 'utf8'));

  let sidecarText: string | undefined;
  try {
    sidecarText = norm(await fsp.readFile(sidecarPathFor(filePath), 'utf8'));
  } catch {
    sidecarText = undefined;
  }

  let centralFields: MetaFields | undefined;
  try {
    centralFields = await readCentralEntry(loc.root, filePath);
  } catch (err) {
    // An unreadable central file must not be mistaken for "no metadata" — in
    // single-file mode that would recreate every page on the next sync.
    if (loc.storage === 'single-file') throw err;
  }

  const present: Record<Exclude<MetaSource, 'none'>, boolean> = {
    frontmatter: hasFrontMatter(mdText),
    sidecar: sidecarText !== undefined,
    'single-file': centralFields !== undefined,
  };
  const order: Exclude<MetaSource, 'none'>[] = [
    loc.storage,
    'sidecar',
    'single-file',
    'frontmatter',
  ];
  const source = order.find((s) => present[s]);

  if (source === 'frontmatter') {
    const { meta, content } = parsePageFile(mdText, filePath);
    return {
      filePath,
      meta,
      content,
      hadFrontMatter: true,
      metaSource: 'frontmatter',
      mdText,
      sidecarText,
      centralFields,
    };
  }

  if (source === 'sidecar' || source === 'single-file') {
    // The stored metadata is authoritative. If the `.md` still carries a
    // front-matter block (a hand-edit, or a half-finished migration), strip it
    // from the body.
    const content = stripFrontMatter(mdText, filePath);
    const defaults = defaultMetaForFile(filePath, content);
    const meta =
      source === 'sidecar'
        ? parseSidecar(sidecarText!, defaults)
        : metaFromFields(centralFields!, defaults);
    return {
      filePath,
      meta,
      content,
      hadFrontMatter: true,
      metaSource: source,
      mdText,
      sidecarText,
      centralFields,
    };
  }

  const { meta, content } = parsePageFileLoose(mdText, filePath);
  return {
    filePath,
    meta,
    content,
    hadFrontMatter: false,
    metaSource: 'none',
    mdText,
  };
}

export interface SaveResult {
  wroteSidecar?: boolean;
  removedSidecar?: boolean;
}

// Write a page back to disk in `loc.storage` mode, and clear its metadata out of
// the other two places so exactly one copy exists. `stampSyncHash` folds a fresh
// `pageDigest` into the metadata (use after a successful sync); pass `false` for
// an offline tidy that must not change the hash.
export async function savePage(
  filePath: string,
  meta: PageMeta,
  content: string,
  opts: MetaLocation & { stampSyncHash: boolean }
): Promise<SaveResult> {
  const finalMeta = opts.stampSyncHash
    ? { ...meta, syncHash: pageDigest(meta, content) }
    : meta;
  const defaults = defaultMetaForFile(filePath, content);
  const sidecarPath = sidecarPathFor(filePath);
  const result: SaveResult = {};

  // Best-effort: leftovers in the modes we are not writing are cleaned up but
  // must never fail the save that just succeeded.
  const dropSidecar = async () => {
    try {
      await fsp.unlink(sidecarPath);
      result.removedSidecar = true;
    } catch {
      /* none there */
    }
  };
  const dropCentral = () =>
    removeCentralEntry(opts.root, filePath).catch(() => undefined);

  switch (opts.storage) {
    case 'sidecar':
      await fsp.writeFile(filePath, content, 'utf8');
      await fsp.writeFile(
        sidecarPath,
        serializeSidecar(finalMeta, defaults),
        'utf8'
      );
      result.wroteSidecar = true;
      await dropCentral();
      break;

    case 'single-file':
      // Record the entry first: it throws for a file outside the root, before
      // we have touched the .md.
      await writeCentralEntry(
        opts.root,
        filePath,
        nonDefaultFields(finalMeta, defaults)
      );
      await fsp.writeFile(filePath, content, 'utf8');
      await dropSidecar();
      break;

    default:
      await fsp.writeFile(
        filePath,
        serializePageFile(finalMeta, content, filePath),
        'utf8'
      );
      await dropSidecar();
      await dropCentral();
  }
  return result;
}

// Whether an otherwise-unchanged page is not in its canonical on-disk form for
// `storage` and should be rewritten (the "tidied" path in Sync Folder, and
// Normalize Metadata). False when there is no metadata at all.
export function pageNeedsRewrite(
  loaded: LoadedPage,
  storage: MetadataStorage
): boolean {
  if (loaded.metaSource === 'none') return false;
  const { meta, content, filePath } = loaded;
  const defaults = defaultMetaForFile(filePath, content);
  const hasSidecar = loaded.sidecarText !== undefined;
  const hasCentral = loaded.centralFields !== undefined;

  switch (storage) {
    case 'sidecar':
      if (loaded.metaSource !== 'sidecar') return true; // migrate -> sidecar
      if (loaded.mdText !== content) return true; // stray front matter / cruft in the .md
      if (hasCentral) return true; // stale central entry
      return !sidecarIsCanonical(loaded.sidecarText ?? '', meta, defaults);

    case 'single-file':
      if (loaded.metaSource !== 'single-file') return true; // migrate -> central
      if (loaded.mdText !== content) return true;
      if (hasSidecar) return true; // stale sidecar
      return !sameFields(
        loaded.centralFields ?? {},
        nonDefaultFields(meta, defaults)
      );

    default:
      if (loaded.metaSource !== 'frontmatter') return true; // migrate -> front matter
      if (hasSidecar || hasCentral) return true; // stale copies elsewhere
      return loaded.mdText !== serializePageFile(meta, content, filePath);
  }
}

/** Move a page's sidecar to follow the `.md` when it is renamed/moved. */
export async function renameSidecar(
  oldMdPath: string,
  newMdPath: string
): Promise<boolean> {
  try {
    await fsp.rename(sidecarPathFor(oldMdPath), sidecarPathFor(newMdPath));
    return true;
  } catch {
    return false;
  }
}

// Carry a page's (or, for a folder, every page's) metadata along with a rename
// or move. Best effort: it can only follow what happened through the editor —
// a `mv` or `git mv` outside VS Code fires no event, and that page's metadata
// is left behind (for a central entry it is orphaned under the old key until
// Normalize Metadata prunes it).
//
//  - front matter travels inside the `.md`, so there is nothing to do;
//  - a page's sidecar is renamed with it (a moved folder carries its own);
//  - central entries are re-keyed to the new path, across sync roots if the
//    move crosses one, or written into the destination's own storage mode if it
//    isn't single-file.
//
// Idempotent, so it is safe for the rename event handler and an explicit call
// to both run for the same move.
export async function relocateMetadata(opts: {
  oldPath: string;
  newPath: string;
  isDir: boolean;
  /** Sync root the old location belonged to, if any. */
  oldRoot?: string;
  /** Storage mode and root that now govern the new location. */
  newLoc?: MetaLocation;
}): Promise<void> {
  const { oldPath, newPath, isDir, oldRoot, newLoc } = opts;

  if (!isDir) await renameSidecar(oldPath, newPath);
  if (!oldRoot) return;

  const moves = await findCentralMoves(oldRoot, oldPath, newPath, isDir);
  if (moves.length === 0) return;

  const toPut: { key: string; fields: MetaFields }[] = [];
  const toCarry: { file: string; fields: MetaFields }[] = [];
  for (const m of moves) {
    const key =
      newLoc?.storage === 'single-file'
        ? centralKey(newLoc.root, m.newFile)
        : undefined;
    if (key !== undefined) toPut.push({ key, fields: m.fields });
    else toCarry.push({ file: m.newFile, fields: m.fields });
  }

  const oldKeys = moves.map((m) => m.oldKey);
  const put = (pages: Record<string, MetaFields>) => {
    for (const { key, fields } of toPut) pages[key] = fields;
  };
  const drop = (pages: Record<string, MetaFields>) => {
    for (const k of oldKeys) delete pages[k];
  };

  if (newLoc && toPut.length > 0 && newLoc.root === oldRoot) {
    await updateCentral(oldRoot, (pages) => {
      drop(pages);
      put(pages); // after the drop, so a same-key overlap keeps the new entry
    });
  } else {
    if (newLoc && toPut.length > 0) await updateCentral(newLoc.root, put);
    await updateCentral(oldRoot, drop);
  }

  // Destination isn't single-file (or the page landed outside its root): the
  // metadata has to go somewhere the file can carry it.
  for (const { file, fields } of toCarry) {
    let mdText: string;
    try {
      mdText = norm(await fsp.readFile(file, 'utf8'));
    } catch {
      continue; // not there (a non-.md file, or already gone)
    }
    const content = stripFrontMatter(mdText, file);
    const meta = metaFromFields(fields, defaultMetaForFile(file, content));
    const storage =
      newLoc && newLoc.storage !== 'single-file'
        ? newLoc.storage
        : 'frontmatter';
    await savePage(file, meta, content, {
      storage,
      root: newLoc?.root ?? oldRoot,
      stampSyncHash: false,
    });
  }
}
