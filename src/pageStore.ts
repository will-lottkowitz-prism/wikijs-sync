import * as fsp from 'fs/promises';
import {
  PageMeta,
  pageDigest,
  parsePageFile,
  parsePageFileLoose,
  serializePageFile,
} from './pageFile';
import {
  MetadataStorage,
  parseSidecar,
  serializeSidecar,
  sidecarIsCanonical,
  sidecarPathFor,
} from './sidecar';

// Storage-mode-aware read/write for a local page file. Callers work with a
// `{ meta, content }` pair and never touch the front-matter block or the
// sidecar file directly.

export interface LoadedPage {
  meta: PageMeta;
  content: string;
  /** Metadata was found somewhere (front matter or sidecar), not synthesized. */
  hadFrontMatter: boolean;
  metaSource: 'frontmatter' | 'sidecar' | 'none';
  /** The `.md` text as read (CRLF-normalized). */
  mdText: string;
  /** The sidecar text as read, when a sidecar file was present. */
  sidecarText?: string;
}

const norm = (s: string): string => s.replace(/\r\n/g, '\n');

export async function loadPage(filePath: string): Promise<LoadedPage> {
  const mdText = norm(await fsp.readFile(filePath, 'utf8'));

  let sidecarText: string | undefined;
  try {
    sidecarText = norm(await fsp.readFile(sidecarPathFor(filePath), 'utf8'));
  } catch {
    sidecarText = undefined;
  }

  if (sidecarText !== undefined) {
    // The sidecar is authoritative. If the `.md` still carries a front-matter
    // block (a hand-edit, or a half-finished migration), strip it from the body.
    let content = mdText;
    try {
      content = parsePageFile(mdText).content;
    } catch {
      /* no front-matter block — the whole file is the body */
    }
    return {
      meta: parseSidecar(sidecarText),
      content,
      hadFrontMatter: true,
      metaSource: 'sidecar',
      mdText,
      sidecarText,
    };
  }

  const { meta, content, hadFrontMatter } = parsePageFileLoose(
    mdText,
    filePath
  );
  return {
    meta,
    content,
    hadFrontMatter,
    metaSource: hadFrontMatter ? 'frontmatter' : 'none',
    mdText,
  };
}

export interface SaveResult {
  wroteSidecar?: boolean;
  removedSidecar?: boolean;
}

// Write a page back to disk in `storage` mode. `stampSyncHash` folds a fresh
// `pageDigest` into the metadata (use after a successful sync); pass `false` for
// an offline tidy that must not change the hash.
export async function savePage(
  filePath: string,
  meta: PageMeta,
  content: string,
  opts: { storage: MetadataStorage; stampSyncHash: boolean }
): Promise<SaveResult> {
  const finalMeta = opts.stampSyncHash
    ? { ...meta, syncHash: pageDigest(meta, content) }
    : meta;
  const sidecarPath = sidecarPathFor(filePath);

  if (opts.storage === 'sidecar') {
    await fsp.writeFile(filePath, content, 'utf8');
    await fsp.writeFile(sidecarPath, serializeSidecar(finalMeta), 'utf8');
    return { wroteSidecar: true };
  }

  await fsp.writeFile(filePath, serializePageFile(finalMeta, content), 'utf8');
  try {
    await fsp.unlink(sidecarPath);
    return { removedSidecar: true };
  } catch {
    return {};
  }
}

// Whether an otherwise-unchanged page is not in its canonical on-disk form for
// `storage` and should be rewritten (the "tidied" path in Sync Folder, and
// Normalize Metadata). False when there is no metadata at all.
export function pageNeedsRewrite(
  loaded: LoadedPage,
  storage: MetadataStorage
): boolean {
  if (loaded.metaSource === 'none') return false;
  const { meta, content } = loaded;

  if (storage === 'sidecar') {
    if (loaded.metaSource !== 'sidecar') return true; // migrate front matter -> sidecar
    if (loaded.mdText !== content) return true; // stray front matter / cruft in the .md
    return !sidecarIsCanonical(loaded.sidecarText ?? '', meta);
  }

  if (loaded.metaSource === 'sidecar') return true; // migrate sidecar -> front matter
  return loaded.mdText !== serializePageFile(meta, content);
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
