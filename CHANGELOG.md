# Changelog

## 0.8.2 — 2026-09-02

- First public release: moved to its own repository
  ([will-lottkowitz-prism/wikijs-sync](https://github.com/will-lottkowitz-prism/wikijs-sync))
  and published to the VS Code Marketplace. No functional change from 0.8.1.

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
