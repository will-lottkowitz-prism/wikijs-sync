# Wiki.js Sync

SFTP-style workflow for editing [Wiki.js](https://js.wiki) pages in VS Code:
pages live as local Markdown files (viewed with the built-in Markdown preview),
and you download / upload them to your Wiki.js instance from the editor.

By Will Lotto ([xQx](https://github.com/will-lottkowitz-prism)). Source, issues
and pull requests: <https://github.com/will-lottkowitz-prism/wikijs-sync>

## Quick start

1. **Set the wiki URL** — either globally in Settings (`wikijsSync.url`, e.g.
   `http://localhost:3000`) or per-folder in a `.wikisync.json` (below).
2. **Set an API token** — run **Wiki.js Sync: Set API Token** and paste a token
   from Wiki.js *Administration → API Access*. It's kept in VS Code SecretStorage
   (not written to disk, not synced). Alternatives: the `wikijsSync.token`
   setting, or a `"token"` in a `.wikisync.json`.
3. **Map a folder to the wiki** — right-click a folder → **Wiki.js Sync: Add
   .wikisync.json to This Folder**, or hand-write the file (below).
4. Edit `.md` files, then right-click → **Upload This Page**, or a folder →
   **Sync Folder with Wiki (Two-Way)** / **Upload Folder** / **Download Folder**.

## `.wikisync.json` — per-folder config

Drop a `.wikisync.json` into a folder to say *"this folder is a slice of the
wiki"*. It sets the wiki path the folder maps to, which files sync, and
(optionally) a different wiki URL / token than the global settings. The nearest
`.wikisync.json` found walking **up** from the file or folder you act on wins.

```jsonc
{
  // Wiki.js base URL — overrides the wikijsSync.url setting (optional)
  "url": "http://localhost:3000",

  // The Wiki.js path this folder maps to. A file at
  //   <this folder>/guide/intro.md
  // becomes wiki page
  //   Products/my-project/guide/intro
  "wikiPath": "Products/my-project",

  // How non-.md files under this folder are handled:
  //   true  (default) — uploaded as Wiki.js assets, mirroring their path
  //   false           — ignored; only .md files sync
  "assets": true,

  // File selection (optional). Use ONE of:
  //   "include": ["**/*.md"]           — whitelist: only these globs sync
  //   "exclude": ["drafts/**", "*.tmp"] — ignorelist: everything except these
  "exclude": ["drafts/**"],

  // Per-folder API token override (optional). If you set this,
  // add .wikisync.json to your .gitignore.
  "token": "..."
}
```

The editor gives you completion and validation for this file (JSON schema). The
status bar (bottom right, on Markdown files) shows which wiki path the file you're
editing resolves to — click it to open the `.wikisync.json` in charge.

### Use case: a `docs/` folder in each project

The point of `.wikisync.json` is that **each project can own its slice of the
wiki**. Put one in the project's `docs/` folder:

```
my-project/
├── src/…
└── docs/
    ├── .wikisync.json     → { "wikiPath": "Products/my-project", "assets": true }
    ├── overview.md        → wiki page  Products/my-project/overview
    ├── architecture.md    → wiki page  Products/my-project/architecture
    └── images/
        └── topology.png   → asset      /Products/my-project/images/topology.png
```

Now anyone who checks out `my-project` can right-click `docs/` →
**Sync Folder with Wiki (Two-Way)** and their docs round-trip to
`Products/my-project/*` on the shared wiki — no global settings to configure,
no single "content" mirror folder. Commit the `.wikisync.json` (without a
`token`) so it travels with the repo.

### File selection

| In `.wikisync.json` | Effect |
| --- | --- |
| *(nothing)* | All `.md` files sync. Non-`.md` files sync as assets when `assets` is `true`. |
| `"assets": false` | Only `.md` files sync; everything else is ignored. |
| `"include": ["**/*.md", "reference/**"]` | **Whitelist** — a file syncs only if it matches one of these globs. |
| `"exclude": ["drafts/**", "*.wip.md"]` | **Ignorelist** — a file never syncs if it matches one of these globs. Replaces the `wikijsSync.exclude` setting for this folder. |

Globs are gitignore-style: `*` within a path segment, `**` across segments,
`?` a single character. `include` and `exclude` can be combined (exclude wins).
Dotfiles and `node_modules` are always skipped.

### How local files map to wiki pages

With `wikiPath` set to `Products/x` and the `.wikisync.json` in folder `F`:

| Local file | Wiki page |
| --- | --- |
| `F/intro.md` | `Products/x/intro` |
| `F/guide/setup.md` | `Products/x/guide/setup` |
| `F/index.md` | `Products/x` (the section landing page) |
| `F/Node.js Notes.md` | `Products/x/Node-js-Notes` (file renamed — see [Page paths](#page-paths)) |
| `F/diagram.png` | asset `/Products/x/diagram.png` (when `assets: true`) |

An empty or absent `wikiPath` maps the folder straight to the wiki root.

## Commands

Right-click in the Explorer, or the Command Palette (`Ctrl/Cmd+Shift+P` → "Wiki.js").

| Command | What it does |
| --- | --- |
| **Set API Token** | Store a token in SecretStorage. |
| **Add .wikisync.json to This Folder** | Scaffold a `.wikisync.json` in the right-clicked folder (prompts for the wiki path). |
| **Upload This Page** | Push one `.md` file. Creates the page if it has no `id` yet; generates front matter if the file has none. |
| **Download Latest (Overwrite Local)** | Re-fetch one page you already have locally, discarding local edits. |
| **Sync Folder with Wiki (Two-Way)** | Right-click a folder. For each local `.md`, a three-way compare against its last-synced state: unchanged on both sides → skipped; changed only locally → pushed; changed only on the server → pulled (so a web-UI edit is never clobbered); changed on **both** sides → prompt to pick a winner. Remote pages with no local file are downloaded. Eligible non-`.md` files upload as assets. |
| **Upload Folder (Push Subtree)** | Right-click a folder. One-way push of every eligible `.md` (and asset) under it. Nothing is pulled. |
| **Download Folder (Pull Subtree)** | Right-click a folder. One-way pull of every wiki page at or under the folder's mapped path, **overwriting local files**. Local-only files are left in place, not deleted. |
| **Normalize Front Matter (Folder)** | Right-click a folder. Rewrites every `.md` so its front-matter block is canonical — drops a stale `path:` line and any unknown keys, fixes key order. Page bodies untouched. **Local only**: touches nothing on the wiki, needs no token or URL. |
| **Upload Asset** | Right-click a non-`.md` file. Under a synced folder its server location is derived automatically; elsewhere you pick the asset folder. Offers to copy / insert a Markdown link. |
| **Download All Pages** / **Upload All Pages** / **Download Page…** | *Legacy whole-wiki mirror* — operate on `wikijsSync.contentDir` mapped to the wiki root. Shown only on the `contentDir` folder. Use the folder commands with `.wikisync.json` instead. |

Set `wikijsSync.uploadOnSave` to `true` to upload a `.md` file every time it's
saved (if it's inside a synced folder and passes that folder's include/exclude).

## Settings

| Setting | Default | Purpose |
| --- | --- | --- |
| `wikijsSync.url` | `""` | Default wiki URL. A `.wikisync.json` `"url"` overrides it per folder. |
| `wikijsSync.token` | `""` | Default API token. Resolution order: `.wikisync.json` `"token"` → **Set API Token** (SecretStorage) → this setting. |
| `wikijsSync.contentDir` | `"content"` | **Legacy / fallback** — the folder used as a whole-wiki mirror when no `.wikisync.json` is found. |
| `wikijsSync.uploadOnSave` | `false` | Upload a `.md` file on every save. |
| `wikijsSync.syncNonMarkdownAsAssets` | `true` | Default for a `.wikisync.json`'s `"assets"`. |
| `wikijsSync.exclude` | `["**/.*", "**/node_modules/**"]` | Default ignore globs for folders that don't set their own `"exclude"` / `"include"`. |
| `wikijsSync.autoRenameIllegalPaths` | `"prompt"` | When a file's location would produce a Wiki.js-illegal path: `prompt` (ask, with a "…All" button), `auto` (rename + log), `off` (skip + report). |

## Page paths

A page's Wiki.js path is **derived entirely from where the file sits** relative to
the folder its `.wikisync.json` maps to — `guide/intro.md` in a folder mapped to
`Products/x` is page `Products/x/guide/intro`, and a folder's `index.md` is that
folder's landing page. There is **no `path` field** in the front matter; a stale
one left by an older version is ignored and dropped the next time the file is
written (run **Normalize Front Matter (Folder)** to clean a whole tree at once,
offline). Move or rename a file and the page moves with it on the next sync — its
`id` travels in the front matter, so history is kept. If a file carries an `id`
but sits where that page *isn't* on the server, the extension asks once whether
it's a move or a copy that should become its own new page (answer for a whole
reorg with **…All**).

Wiki.js rejects a page path containing `.`, a space, `\` or `//`, so a file whose
name or folder would produce one is **renamed** to a legal form first (illegal
characters → `-`, case preserved), controlled by `wikijsSync.autoRenameIllegalPaths`
— e.g. `Node.js Notes.md` → `Node-js-Notes.md` → page `…/Node-js-Notes`. Renaming
doesn't fix `[links](/other/page.md)` in *other* files that point at the old name.

## Front matter

Each local file is Markdown with a YAML front matter block:

```
---
id: 3
title: Page Title
description: "..."
editor: markdown
locale: en
isPublished: true
isPrivate: false
tags: [tag1, tag2]
updatedAt: 2026-08-06T04:13:34.389Z
syncHash: 9f2c…
---
Page content starts here...
```

`updatedAt` is the conflict-detection anchor: before an upload updates an
existing page, the extension compares the server's current `updatedAt` with the
value it last saw. If someone edited the page through the Wiki.js web UI in the
meantime you get a confirmation prompt instead of a silent overwrite. Timestamps
are compared by parsed instant, not raw string, since Wiki.js's GraphQL
serializes them inconsistently between endpoints.

`syncHash` is a sha256 of the page body plus the metadata fields Wiki.js stores,
as they stood at the last successful sync. **Sync Folder** uses it to recognise a
file you haven't touched and skip it, instead of re-uploading every file on every
run. Both fields are managed by the extension — don't hand-edit them. Files synced
before this field existed get one re-upload on the next sync, then settle.

### First upload without front matter

Any upload path accepts a plain `.md` file with no `---` block. Metadata is
generated: `title` from a leading `# Heading` (else the filename);
`editor`/`locale`/`isPublished`/`isPrivate`/`tags` get defaults (`markdown`,
`en`, `true`, `false`, `[]`); the page path comes from the file's location. The
generated front matter is written back to the file once the page is created, so
this only happens once per file.

## Assets

When a folder's `assets` is `true`, non-`.md` files under it are uploaded to the
Wiki.js asset folder that mirrors their path — a file at
`<folder>/images/diagram.png` with `wikiPath: "Products/x"` is uploaded to
`/Products/x/images/diagram.png`, creating any missing asset folders. An asset
already present at that path (same filename, same folder) is left alone.

This is **push-only**: assets are never pulled back down (they carry no front
matter to track sync state), so an asset added through the Wiki.js web UI won't
appear locally, and **Download Folder** / **Download All Pages** fetch pages only.

## License

MIT © 2026 Will Lotto. See [LICENSE](LICENSE).
