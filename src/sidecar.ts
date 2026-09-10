import * as path from 'path';
import { PageMeta, parseMetaFromLines, serializeMetaLines } from './pageFile';

// Where a page's sync metadata is kept:
//  - 'frontmatter' (default): a `---` YAML block at the top of the `.md` file.
//  - 'sidecar': a hidden sibling file, leaving the `.md` as pure Markdown so it
//    stays clean when the same file is also published somewhere other than the
//    wiki.
export type MetadataStorage = 'frontmatter' | 'sidecar';

// Sibling dotfile that holds a page's metadata in 'sidecar' mode:
//   docs/guide/intro.md  ->  docs/guide/.intro.md.wikisync.yaml
// The leading dot hides it and makes the folder walk / default excludes skip it;
// it sits next to the `.md` so it travels with the file. Commit it alongside.
export const SIDECAR_SUFFIX = '.wikisync.yaml';

export function sidecarPathFor(mdPath: string): string {
  return path.join(
    path.dirname(mdPath),
    `.${path.basename(mdPath)}${SIDECAR_SUFFIX}`
  );
}

/** True for a sidecar's own filename, so folder walks never treat it as content. */
export function isSidecarName(name: string): boolean {
  return name.startsWith('.') && name.endsWith(SIDECAR_SUFFIX);
}

const HEADER =
  '# Wiki.js Sync — page metadata kept out of the .md so the Markdown stays\n' +
  '# clean when published elsewhere. Managed by the extension; do not hand-edit.\n';

export function serializeSidecar(meta: PageMeta): string {
  return HEADER + serializeMetaLines(meta).join('\n') + '\n';
}

export function parseSidecar(text: string): PageMeta {
  return parseMetaFromLines(text);
}

/** True when `sidecarText` already is the canonical serialization of `meta`. */
export function sidecarIsCanonical(
  sidecarText: string,
  meta: PageMeta
): boolean {
  return sidecarText.replace(/\r\n/g, '\n') === serializeSidecar(meta);
}
