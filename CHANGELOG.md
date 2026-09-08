# Changelog

## 0.10.1 — 2026-09-09

- **Sync Folder's "changed both locally and on the server" prompt now has
  "Upload All" / "Download All"** — pick one resolution once and it applies to
  every remaining conflict in the run (same as the move/copy and rename
  prompts). Cancelling still leaves that file untouched.

## 0.10.0 — 2026-09-08

- **Page paths are always sanitized to a form Wiki.js accepts.** Wiki.js rejects
  a path containing `.`, a space, `\` or `//`, and a first segment that's a
  single character, a locale code, or a reserved word (`js`, `api`, …). The path
  derived from a file's location now has those mapped out (illegal characters →
  `-`, case preserved), so a page like `Node.js Notes.md` uploads cleanly
  instead of failing.
- **Local files with an illegal location are renamed.** When a file's name or
  folder would produce a path Wiki.js won't take, the extension renames the
  local file to the sanitized form so local and remote agree and round-trips
  stay stable. New setting `wikijsSync.autoRenameIllegalPaths`: `prompt`
  (default — asks, with a "Rename All" button for bulk runs), `auto` (rename +
  log), `off` (skip the file and report it). Renaming does **not** fix
  `[links](/other/page.md)` in other files that point at the old name.
- **`path:` is stripped from files that were otherwise unchanged.** Older
  versions stored a `path:` line in the front matter; 0.9.0 stopped writing it
  but only rewrote a file when it actually synced, so untouched files kept the
  stale line. **Sync Folder** now tidies those in place (reported as `tidied`) —
  no network call, no page-history bump.
- **New command: Normalize Front Matter (Folder).** Rewrites every `.md` under a
  folder so its front-matter block is canonical (drops `path:` and any unknown
  keys, fixes key order) — page bodies untouched, no network access at all. A
  one-shot cleanup that needs no token or wiki URL.

## 0.9.0 — 2026-09-03

- **`path` is gone from the front matter.** A page's Wiki.js path is now derived
  entirely from where the file lives relative to the folder its `.wikisync.json`
  maps to (the same rule that already decided where downloads land). Move or
  rename a file and the page moves with it on the next sync — its `id` still
  travels in the front matter, so history is preserved. A stale `path:` line in
  an older file is ignored and dropped the next time the file is written.
  - `syncHash` no longer folds in the path, so every file gets **one re-upload**
    on the first sync after upgrading, then settles (same as the 0.8.0 change).
- **"Move or new page?" now has an "…All" button.** When a file carries an `id`
  but sits where that page isn't on the server, the extension still asks whether
  it's a genuine move or a copy that should become its own new page — but during
  a bulk reorganisation you can answer once (**Move All** / **New Page for All**)
  and it applies to every remaining file in that run.
- Fixed a moved file being re-created at its **old** path locally after
  **Sync Folder** pushed the move (the stale entry in the page list was
  re-downloaded).

## 0.8.3 — 2026-09-03

- **Fix: sync repeatedly failed for a page that exists on the server but has no
  `id` in the local file** — `Variable "$id" of required type "Int!" was not
  provided`. When `createPage` reported "already exists" and the extension
  adopted the server id to update instead, the `PageMeta`'s own (undefined)
  `id` field clobbered the real id in the GraphQL variables, so Wiki.js got
  `$id: null` and rejected the whole mutation. The id is now applied last.

## 0.8.1 — 2026-09-02

- **Self-update.** On startup the extension checks a release manifest for a
  newer sideloaded build and can install it itself, then offers a reload.
  Settings: `wikijsSync.updateFeeds` (an `http(s)` URL or a local synced path to
  a `latest.json`), `wikijsSync.autoUpdate` (`auto` / `prompt` / `off`),
  `wikijsSync.updateCheckIntervalHours`. Command: **Wiki.js Sync: Check for
  Updates**. Marketplace installs update natively and can leave this `off`.

## 0.8.0 — 2026-09-02

Fixed **Sync Folder with Wiki (Two-Way)** never settling — a re-sync of an
untouched folder used to re-upload (or re-download) every file, bumping page
history on the wiki and churning the local front matter each time.

- **Real three-way sync.** Each `.md` is compared against its last-synced state:
  unchanged both sides → **skipped**; changed only locally → pushed; changed only
  on the server → pulled; changed on **both** → a prompt to pick the winner. The
  run summary now reports how many files were skipped as unchanged.
- **`syncHash` front-matter field** — a sha256 of the page body + stored metadata
  at the last sync, so "unchanged" can be detected without fetching and diffing
  the remote copy. Extension-managed; don't hand-edit. Files synced before this
  release get one re-upload on the next sync, then settle.
- **Timestamps compared by parsed instant**, not raw string. Wiki.js's GraphQL
  serializes `updatedAt` differently between `pages.list`, `pages.single` and
  mutation results (ms precision / timezone), which previously made every sync
  see a phantom change and flip-flop between upload and download.

## 0.7.0 — 2026-09-02

Ported the sftp plugin's per-folder config model.

- **`.wikisync.json` per-folder config.** Drop one into any folder to map it to a
  Wiki.js path (`wikiPath`), pick a wiki (`url`) and token (`token`), and choose
  which files sync. The nearest one walking up from the file/folder you act on
  wins. JSON schema + completion in the editor. Main use case: a `.wikisync.json`
  in each project's `docs/` folder so the project owns its slice of the wiki.
- **File selection in the same file:** `assets` (`true` = non-`.md` files upload
  as assets, `false` = only `.md` syncs), `include` (whitelist globs), `exclude`
  (ignorelist globs).
- **Settings** are all native now: added `wikijsSync.token`,
  `wikijsSync.syncNonMarkdownAsAssets`, `wikijsSync.exclude`. `wikijsSync.url`
  and `wikijsSync.contentDir` still work as fallbacks when there's no
  `.wikisync.json`.
- **Token** resolution: `.wikisync.json` `"token"` → **Set API Token**
  (SecretStorage) → `wikijsSync.token` setting.
- New command **Wiki.js Sync: Add .wikisync.json to This Folder** (right-click a
  folder).
- Status-bar item showing which wiki / path the active Markdown file resolves to
  (like the sftp plugin's profile indicator); click to open the governing
  `.wikisync.json`.
- `index.md` at a synced folder's root maps to the folder's `wikiPath` itself
  (section landing page).
- The folder commands (**Sync / Upload / Download Folder**) now work anywhere,
  scoped by the resolved `.wikisync.json`. **Download/Upload All Pages** stay as
  the legacy whole-wiki mirror over `wikijsSync.contentDir`.
- chore: bundled with `esbuild` (one `dist/extension.js` instead of a `tsc` file
  tree); added `eslint` + `prettier`; pure path/glob logic extracted to
  `pathmap.ts` and covered by the monorepo `vitest` suite. Removed the unused
  `"private": true`.

## 0.6.0

- Added **Wiki.js Sync: Upload Folder (Push Subtree)** and **Download Folder
  (Pull Subtree)** — one-way sync of a right-clicked subfolder and everything
  under it.

## 0.5.0 and earlier

- Download/upload Wiki.js pages as local Markdown with YAML front matter,
  two-way folder sync, asset mirroring, upload-on-save, conflict detection via
  `updatedAt`.
