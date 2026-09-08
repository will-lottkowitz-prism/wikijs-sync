import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs/promises';
import {
  AssetFolder,
  createAssetFolder,
  createPage,
  getPage,
  getPageByPath,
  getPageStub,
  listAssetFolders,
  listAssets,
  listPages,
  updatePage,
  uploadAsset,
} from './wikijsClient';
import {
  needsCanonicalRewrite,
  pageDigest,
  parsePageFile,
  parsePageFileLoose,
  sameInstant,
  serializePageFile,
  serializeSynced,
} from './pageFile';
import {
  AutoRenameMode,
  CONFIG_FILENAME,
  SyncContext,
  assetDirForFile,
  assetLinkForFile,
  fileForPagePath,
  fileMatchesContext,
  findConfigFile,
  getSettings,
  pagePathForFile,
  resolveContext,
  resolveLegacyContext,
  resolveToken,
} from './config';

const TOKEN_KEY = 'wikijsSync.token';
const CONTENT_ROOT_CONTEXT_KEY = 'wikijsSync.contentDirs';

// -- context / target helpers -------------------------------------------------

function resolveTargetPath(uri?: vscode.Uri): string {
  if (uri) return uri.fsPath;
  const active = vscode.window.activeTextEditor?.document.uri;
  if (active && active.scheme === 'file') return active.fsPath;
  throw new Error(
    'No file selected. Right-click a .md file, or open one in the editor, then retry.'
  );
}

// A best-effort path to resolve a context for the "All" commands and the token
// dialog: the active editor's folder, else the first workspace folder.
function ambientPath(): string {
  const active = vscode.window.activeTextEditor?.document.uri;
  if (active && active.scheme === 'file') return active.fsPath;
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    throw new Error('Open a workspace folder before using Wiki.js Sync.');
  }
  return folder.uri.fsPath;
}

interface FolderScope {
  /** Absolute path of the right-clicked folder. */
  folderPath: string;
  /** Wiki path prefix for pages under that folder ('' = the context's whole tree). */
  wikiPrefix: string;
}

function resolveFolderScope(
  ctx: SyncContext,
  uri: vscode.Uri | undefined,
  verb: string
): FolderScope {
  const folderPath = uri?.fsPath;
  if (!folderPath) {
    throw new Error(`Right-click a folder in the Explorer to ${verb} it.`);
  }
  const rel = path.relative(ctx.root, folderPath);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(
      `"${folderPath}" is outside ${describeRoot(ctx)}. ${verb} from within that folder instead.`
    );
  }
  const relPosix = rel === '' ? '' : rel.split(path.sep).join('/');
  return {
    folderPath,
    wikiPrefix: [ctx.wikiPath, relPosix].filter(Boolean).join('/'),
  };
}

function describeRoot(ctx: SyncContext): string {
  return ctx.configPath
    ? `the folder configured by ${path.relative(ctx.root, ctx.configPath) || CONFIG_FILENAME} (${ctx.root})`
    : `the content dir (${ctx.root})`;
}

// The remote pages at or under a wiki-path prefix ('' = all).
function pagesUnder<T extends { path: string }>(
  pages: T[],
  prefix: string
): T[] {
  return pages.filter(
    (p) => prefix === '' || p.path === prefix || p.path.startsWith(`${prefix}/`)
  );
}

// -- registration -----------------------------------------------------------

export function registerCommands(context: vscode.ExtensionContext) {
  const out = vscode.window.createOutputChannel('Wiki.js Sync');

  context.subscriptions.push(
    out,
    vscode.commands.registerCommand('wikijsSync.setToken', () =>
      setToken(context)
    ),
    vscode.commands.registerCommand(
      'wikijsSync.initConfig',
      (uri?: vscode.Uri) => guarded(() => initConfig(out, uri))
    ),
    vscode.commands.registerCommand('wikijsSync.downloadAll', () =>
      guarded(() => downloadAll(context, out))
    ),
    vscode.commands.registerCommand('wikijsSync.pickAndDownload', () =>
      guarded(() => pickAndDownload(context, out))
    ),
    vscode.commands.registerCommand(
      'wikijsSync.uploadFile',
      (uri?: vscode.Uri) => guarded(() => uploadFileCommand(context, out, uri))
    ),
    vscode.commands.registerCommand(
      'wikijsSync.downloadFile',
      (uri?: vscode.Uri) =>
        guarded(() => downloadFileCommand(context, out, uri))
    ),
    vscode.commands.registerCommand('wikijsSync.uploadAll', () =>
      guarded(() => uploadAll(context, out))
    ),
    vscode.commands.registerCommand(
      'wikijsSync.uploadAsset',
      (uri?: vscode.Uri) => guarded(() => uploadAssetCommand(context, out, uri))
    ),
    vscode.commands.registerCommand(
      'wikijsSync.syncFolder',
      (uri?: vscode.Uri) => guarded(() => syncFolder(context, out, uri))
    ),
    vscode.commands.registerCommand(
      'wikijsSync.uploadFolder',
      (uri?: vscode.Uri) => guarded(() => uploadFolder(context, out, uri))
    ),
    vscode.commands.registerCommand(
      'wikijsSync.downloadFolder',
      (uri?: vscode.Uri) => guarded(() => downloadFolder(context, out, uri))
    ),
    vscode.commands.registerCommand(
      'wikijsSync.normalizeFolder',
      (uri?: vscode.Uri) => guarded(() => normalizeFolder(out, uri))
    ),
    vscode.workspace.onDidSaveTextDocument((doc) => onSave(context, out, doc)),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('wikijsSync')) updateContentRootContext();
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() =>
      updateContentRootContext()
    )
  );

  updateContentRootContext();
}

// Lets "Download/Upload All Pages" appear only on the exact legacy contentDir
// folder (the `.wikisync.json` workflow uses the per-folder commands instead).
function updateContentRootContext() {
  try {
    const settings = getSettings();
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!settings.url || !folder) throw new Error('not configured');
    const contentDir = path.isAbsolute(settings.contentDir)
      ? settings.contentDir
      : path.join(folder, settings.contentDir);
    vscode.commands.executeCommand('setContext', CONTENT_ROOT_CONTEXT_KEY, {
      [contentDir]: true,
    });
  } catch {
    vscode.commands.executeCommand('setContext', CONTENT_ROOT_CONTEXT_KEY, {});
  }
}

async function guarded(fn: () => Promise<void>) {
  try {
    await fn();
  } catch (err: any) {
    vscode.window.showErrorMessage(`Wiki.js Sync: ${err.message ?? err}`);
  }
}

async function setToken(context: vscode.ExtensionContext) {
  const token = await vscode.window.showInputBox({
    prompt: 'Wiki.js API token (Administration -> API Access -> New API Key)',
    password: true,
    ignoreFocusOut: true,
  });
  if (token) {
    await context.secrets.store(TOKEN_KEY, token.trim());
    vscode.window.showInformationMessage(
      'Wiki.js Sync: API token saved to SecretStorage.'
    );
  }
}

// -- init config -----------------------------------------------------------

async function initConfig(out: vscode.OutputChannel, uri?: vscode.Uri) {
  const folderPath = uri?.fsPath;
  if (!folderPath) {
    throw new Error(
      `Right-click a folder in the Explorer to add a ${CONFIG_FILENAME} to it.`
    );
  }
  const configPath = path.join(folderPath, CONFIG_FILENAME);
  try {
    await fs.access(configPath);
    const doc = await vscode.workspace.openTextDocument(configPath);
    await vscode.window.showTextDocument(doc);
    return;
  } catch {
    /* does not exist yet - create it */
  }

  const existing = findConfigFile(folderPath);
  if (existing && path.dirname(existing) !== folderPath) {
    const proceed = await vscode.window.showWarningMessage(
      `A ${CONFIG_FILENAME} already applies here (${existing}). Add another one for this folder anyway?`,
      { modal: true },
      'Add anyway'
    );
    if (proceed !== 'Add anyway') return;
  }

  const settings = getSettings();
  const wikiPath = await vscode.window.showInputBox({
    prompt: `Wiki.js path this folder maps to (e.g. "Products/my-project"). Leave blank for the wiki root.`,
    ignoreFocusOut: true,
  });
  if (wikiPath === undefined) return; // cancelled

  const template: Record<string, unknown> = {};
  if (!settings.url) template.url = 'http://your-wiki:3000';
  template.wikiPath = wikiPath.replace(/^\/+|\/+$/g, '');
  template.assets = settings.defaultAssets;

  await fs.writeFile(
    configPath,
    JSON.stringify(template, null, 2) + '\n',
    'utf8'
  );
  out.appendLine(`created ${configPath}`);
  const doc = await vscode.workspace.openTextDocument(configPath);
  await vscode.window.showTextDocument(doc);
  vscode.window.showInformationMessage(
    `Wiki.js Sync: created ${CONFIG_FILENAME}. If you add a "token", add this file to .gitignore.`
  );
}

// -- downloads ------------------------------------------------------------

async function downloadAll(
  context: vscode.ExtensionContext,
  out: vscode.OutputChannel
) {
  const ctx = resolveLegacyContext();
  const token = await resolveToken(context, ctx);

  const pages = pagesUnder(await listPages(ctx.url, token), ctx.wikiPath);
  if (pages.length === 0) {
    throw new Error(
      `No Wiki.js pages found at or under "${ctx.wikiPath || '/'}".`
    );
  }

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: 'Wiki.js Sync: downloading pages',
      cancellable: false,
    },
    async (progress) => {
      for (const p of pages) {
        progress.report({ message: p.path, increment: 100 / pages.length });
        const full = await getPage(ctx.url, token, p.id);
        const filePath = fileForPagePath(ctx, full.path);
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        await fs.writeFile(
          filePath,
          serializeSynced(full, full.content),
          'utf8'
        );
        out.appendLine(`downloaded ${full.path} -> ${filePath}`);
      }
    }
  );
  vscode.window.showInformationMessage(
    `Wiki.js Sync: downloaded ${pages.length} page(s).`
  );
}

async function pickAndDownload(
  context: vscode.ExtensionContext,
  out: vscode.OutputChannel
) {
  const ctx = resolveLegacyContext();
  const token = await resolveToken(context, ctx);

  const pages = await listPages(ctx.url, token);
  const picked = await vscode.window.showQuickPick(
    pages.map((p) => ({ label: p.path, description: p.title, id: p.id })),
    { placeHolder: 'Select a Wiki.js page to download' }
  );
  if (!picked) return;

  const full = await getPage(ctx.url, token, picked.id);
  const filePath = fileForPagePath(ctx, full.path);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, serializeSynced(full, full.content), 'utf8');
  out.appendLine(`downloaded ${full.path} -> ${filePath}`);

  const doc = await vscode.workspace.openTextDocument(filePath);
  await vscode.window.showTextDocument(doc);
}

async function downloadFileCommand(
  context: vscode.ExtensionContext,
  out: vscode.OutputChannel,
  uri?: vscode.Uri
) {
  const filePath = resolveTargetPath(uri);
  const ctx = await resolveContext(filePath);
  const token = await resolveToken(context, ctx);

  const text = await fs.readFile(filePath, 'utf8');
  const { meta } = parsePageFile(text);
  if (!meta.id) {
    throw new Error(
      `${filePath} has no page id yet (it was never uploaded). Use "Download Page..." to fetch by path instead.`
    );
  }

  const full = await getPage(ctx.url, token, meta.id);
  await fs.writeFile(filePath, serializeSynced(full, full.content), 'utf8');
  out.appendLine(
    `downloaded ${full.path} -> ${filePath} (overwrote local copy)`
  );
  vscode.window.setStatusBarMessage(
    `Wiki.js: refreshed ${full.path} from server`,
    3000
  );
}

// -- uploads -------------------------------------------------------------

async function uploadFileCommand(
  context: vscode.ExtensionContext,
  out: vscode.OutputChannel,
  uri?: vscode.Uri
) {
  const filePath = resolveTargetPath(uri);
  const ctx = await resolveContext(filePath);
  await syncUpload(context, out, ctx, filePath, { silent: false });
}

async function uploadAll(
  context: vscode.ExtensionContext,
  out: vscode.OutputChannel
) {
  out.show(true);
  const ctx = resolveLegacyContext();
  const token = await resolveToken(context, ctx);

  const files = (await findMarkdownFiles(ctx.root)).filter((f) =>
    fileMatchesContext(ctx, f)
  );
  const assetFiles = ctx.assets
    ? (await findAssetFiles(ctx.root)).filter((f) => fileMatchesContext(ctx, f))
    : [];
  if (files.length === 0 && assetFiles.length === 0) {
    throw new Error(
      `No .md files${ctx.assets ? ' or assets' : ''} found under ${ctx.root}`
    );
  }

  const stats = newStats();
  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: 'Wiki.js Sync: uploading pages & assets',
      cancellable: false,
    },
    (progress) =>
      runUpload(
        context,
        out,
        ctx,
        token,
        files,
        assetFiles,
        stats,
        progress,
        false
      )
  );

  finish(out, `Wiki.js Sync: uploaded ${files.length} page(s)`, stats);
}

// -- asset helpers -----------------------------------------------------------

const MIME_BY_EXT: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
  '.txt': 'text/plain',
  '.csv': 'text/csv',
  '.json': 'application/json',
  '.xml': 'application/xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.mp4': 'video/mp4',
  '.mp3': 'audio/mpeg',
  '.doc': 'application/msword',
  '.docx':
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx':
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.exe': 'application/octet-stream',
};

function guessMime(filename: string): string {
  return (
    MIME_BY_EXT[path.extname(filename).toLowerCase()] ??
    'application/octet-stream'
  );
}

function slugifyFolderSegment(segment: string): string {
  return segment
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

// Resolves the Wiki.js asset folder id for a wiki-relative directory path,
// creating any missing folders along the way. '' resolves to the root, id 0.
async function ensureAssetFolderPath(
  url: string,
  token: string,
  relDir: string
): Promise<number> {
  const segments = relDir.split('/').filter(Boolean).map(slugifyFolderSegment);
  let parentId = 0;
  for (const slug of segments) {
    if (!slug) continue;
    let folders = await listAssetFolders(url, token, parentId);
    let match = folders.find((f) => f.slug === slug);
    if (!match) {
      await createAssetFolder(url, token, parentId, slug);
      folders = await listAssetFolders(url, token, parentId);
      match = folders.find((f) => f.slug === slug);
      if (!match) {
        throw new Error(
          `Could not create or locate asset folder "${slug}" under parent folder ${parentId}.`
        );
      }
    }
    parentId = match.id;
  }
  return parentId;
}

// Uploads a local non-.md file to the Wiki.js asset folder that mirrors its
// path within `ctx` (creating folders as needed), skipping it if a same-named
// asset is already there. Returns whether an upload actually happened.
async function uploadAssetMirrored(
  ctx: SyncContext,
  token: string,
  filePath: string,
  out: vscode.OutputChannel,
  folderCache: Map<string, number>
): Promise<boolean> {
  const relDir = assetDirForFile(ctx, filePath);
  const filename = path.basename(filePath);
  const link = assetLinkForFile(ctx, filePath);

  let folderId = folderCache.get(relDir);
  if (folderId === undefined) {
    folderId = await ensureAssetFolderPath(ctx.url, token, relDir);
    folderCache.set(relDir, folderId);
  }

  const existing = await listAssets(ctx.url, token, folderId);
  if (existing.some((a) => a.filename === filename)) {
    out.appendLine(
      `asset ${filename} already exists on server at ${link}; skipping`
    );
    return false;
  }

  const fileContent = await fs.readFile(filePath);
  await uploadAsset(
    ctx.url,
    token,
    folderId,
    filename,
    fileContent,
    guessMime(filename)
  );
  out.appendLine(
    `uploaded asset ${path.relative(ctx.root, filePath)} -> ${link}`
  );
  return true;
}

// Browse Wiki.js's asset folder tree one level at a time, land on a folder.
async function pickAssetFolder(
  url: string,
  token: string
): Promise<{ folderId: number; folderPath: string } | undefined> {
  const stack: { id: number; slug: string }[] = [{ id: 0, slug: '' }];

  for (;;) {
    const current = stack[stack.length - 1];
    const folderPath = stack
      .slice(1)
      .map((s) => s.slug)
      .join('/');
    const folders = await listAssetFolders(url, token, current.id);

    type Item = vscode.QuickPickItem & {
      action: 'select' | 'up' | 'enter';
      folder?: AssetFolder;
    };
    const items: Item[] = [
      {
        label: '$(cloud-upload) Upload to this folder',
        description: `/${folderPath}`,
        action: 'select',
      },
    ];
    if (stack.length > 1) {
      items.push({ label: '$(arrow-left) ..', action: 'up' });
    }
    items.push(
      ...folders.map((f): Item => ({
        label: `$(folder) ${f.name}`,
        action: 'enter',
        folder: f,
      }))
    );

    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: `Wiki.js asset folder: /${folderPath}`,
      ignoreFocusOut: true,
    });
    if (!picked) return undefined;

    if (picked.action === 'select') {
      return { folderId: current.id, folderPath };
    }
    if (picked.action === 'up') {
      stack.pop();
      continue;
    }
    if (picked.action === 'enter' && picked.folder) {
      stack.push({ id: picked.folder.id, slug: picked.folder.slug });
    }
  }
}

async function uploadAssetCommand(
  context: vscode.ExtensionContext,
  out: vscode.OutputChannel,
  uri?: vscode.Uri
) {
  const filePath = resolveTargetPath(uri);
  const ctx = await resolveContext(filePath);
  const token = await resolveToken(context, ctx);
  const filename = path.basename(filePath);

  const rel = path.relative(ctx.root, filePath);
  const insideRoot = !rel.startsWith('..') && !path.isAbsolute(rel);

  let folderId: number;
  let folderPath: string;

  if (insideRoot) {
    folderPath = assetDirForFile(ctx, filePath);
    folderId = await ensureAssetFolderPath(ctx.url, token, folderPath);

    const existing = await listAssets(ctx.url, token, folderId);
    if (existing.some((a) => a.filename === filename)) {
      const choice = await vscode.window.showWarningMessage(
        `Wiki.js Sync: an asset named "${filename}" already exists at /${folderPath}. Upload anyway (as a duplicate)?`,
        { modal: true },
        'Upload Anyway'
      );
      if (choice !== 'Upload Anyway') return;
    }
  } else {
    const target = await pickAssetFolder(ctx.url, token);
    if (!target) return;
    folderId = target.folderId;
    folderPath = target.folderPath;
  }

  const fileContent = await fs.readFile(filePath);
  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Wiki.js Sync: uploading ${filename}`,
      cancellable: false,
    },
    () =>
      uploadAsset(
        ctx.url,
        token,
        folderId,
        filename,
        fileContent,
        guessMime(filename)
      )
  );

  const link = folderPath ? `/${folderPath}/${filename}` : `/${filename}`;
  out.appendLine(`uploaded asset ${filePath} -> ${link}`);

  const activeMdEditor = vscode.window.visibleTextEditors.find(
    (e) => e.document.languageId === 'markdown'
  );
  const isImage = /^image\//.test(guessMime(filename));
  const snippet = isImage
    ? `![${filename}](${link})`
    : `[${filename}](${link})`;

  const choice = await vscode.window.showInformationMessage(
    `Wiki.js Sync: uploaded "${filename}" to /${folderPath || ''}. Link: ${link}`,
    'Copy Link Markdown',
    ...(activeMdEditor ? ['Insert at Cursor'] : [])
  );
  if (choice === 'Copy Link Markdown') {
    await vscode.env.clipboard.writeText(snippet);
  } else if (choice === 'Insert at Cursor' && activeMdEditor) {
    await activeMdEditor.edit((editBuilder) => {
      editBuilder.insert(activeMdEditor.selection.active, snippet);
    });
  }
}

// -- folder commands ---------------------------------------------------------

interface Stats {
  uploaded: number;
  downloaded: number;
  skipped: number;
  /** Unchanged files whose front matter was rewritten to canonical form. */
  tidied: number;
  conflicts: number;
  failed: number;
  assetsUploaded: number;
  assetsSkipped: number;
  assetsFailed: number;
}
const newStats = (): Stats => ({
  uploaded: 0,
  downloaded: 0,
  skipped: 0,
  tidied: 0,
  conflicts: 0,
  failed: 0,
  assetsUploaded: 0,
  assetsSkipped: 0,
  assetsFailed: 0,
});

function finish(out: vscode.OutputChannel, lead: string, s: Stats) {
  const summary =
    `${lead}` +
    (s.downloaded ? `, ${s.downloaded} downloaded` : '') +
    (s.skipped ? `, ${s.skipped} unchanged` : '') +
    (s.tidied ? `, ${s.tidied} tidied` : '') +
    (s.conflicts ? `, ${s.conflicts} conflict(s) left unresolved` : '') +
    `, ${s.assetsUploaded} asset(s) uploaded` +
    (s.assetsSkipped ? `, ${s.assetsSkipped} already present` : '') +
    (s.assetsFailed ? `, ${s.assetsFailed} asset(s) FAILED` : '') +
    (s.failed ? `, ${s.failed} FAILED (see "Wiki.js Sync" output)` : '') +
    '.';
  out.appendLine(summary);
  if (s.failed || s.assetsFailed || s.conflicts) {
    vscode.window.showWarningMessage(summary);
  } else {
    vscode.window.showInformationMessage(summary);
  }
}

// One-way push of a subtree: every eligible .md file uploaded, every eligible
// non-.md file uploaded as an asset (when the context allows assets). Nothing
// is pulled.
async function runUpload(
  context: vscode.ExtensionContext,
  out: vscode.OutputChannel,
  ctx: SyncContext,
  token: string,
  files: string[],
  assetFiles: string[],
  stats: Stats,
  progress: vscode.Progress<{ message?: string; increment?: number }>,
  skipConflictPrompt: boolean
) {
  const total = files.length + assetFiles.length || 1;
  const moveResolver = new MoveResolver(true);
  const renameResolver = new RenameResolver(true);
  for (const filePath of files) {
    const relFilePath = path.relative(ctx.root, filePath);
    progress.report({ message: relFilePath, increment: 100 / total });
    try {
      const pushed = await syncUpload(context, out, ctx, filePath, {
        silent: true,
        skipConflictPrompt,
        moveResolver,
        renameResolver,
      });
      if (pushed) stats.uploaded++;
      else stats.skipped++;
    } catch (err: any) {
      stats.failed++;
      out.appendLine(`FAILED ${relFilePath}: ${err?.message ?? err}`);
    }
  }

  const folderCache = new Map<string, number>();
  for (const filePath of assetFiles) {
    const relFilePath = path.relative(ctx.root, filePath);
    progress.report({ message: relFilePath, increment: 100 / total });
    try {
      if (await uploadAssetMirrored(ctx, token, filePath, out, folderCache)) {
        stats.assetsUploaded++;
      } else {
        stats.assetsSkipped++;
      }
    } catch (err: any) {
      stats.assetsFailed++;
      out.appendLine(`FAILED asset ${relFilePath}: ${err?.message ?? err}`);
    }
  }
}

async function uploadFolder(
  context: vscode.ExtensionContext,
  out: vscode.OutputChannel,
  uri?: vscode.Uri
) {
  out.show(true);
  const ctx = await resolveContext(uri ?? ambientPath());
  const token = await resolveToken(context, ctx);
  const { folderPath, wikiPrefix } = resolveFolderScope(ctx, uri, 'upload');

  const files = (await findMarkdownFiles(folderPath)).filter((f) =>
    fileMatchesContext(ctx, f)
  );
  const assetFiles = ctx.assets
    ? (await findAssetFiles(folderPath)).filter((f) =>
        fileMatchesContext(ctx, f)
      )
    : [];
  if (files.length === 0 && assetFiles.length === 0) {
    throw new Error(
      `No .md files${ctx.assets ? ' or assets' : ''} found under ${folderPath}`
    );
  }

  const stats = newStats();
  out.appendLine(
    `upload: "${wikiPrefix || '/'}" — ${files.length} page(s), ${assetFiles.length} asset(s)`
  );
  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Wiki.js Sync: uploading ${wikiPrefix || '/'}`,
      cancellable: false,
    },
    (progress) =>
      runUpload(
        context,
        out,
        ctx,
        token,
        files,
        assetFiles,
        stats,
        progress,
        false
      )
  );
  finish(
    out,
    `Wiki.js Sync: uploaded "${wikiPrefix || '/'}" — ${stats.uploaded} page(s)`,
    stats
  );
}

async function downloadFolder(
  context: vscode.ExtensionContext,
  out: vscode.OutputChannel,
  uri?: vscode.Uri
) {
  out.show(true);
  const ctx = await resolveContext(uri ?? ambientPath());
  const token = await resolveToken(context, ctx);
  const { wikiPrefix } = resolveFolderScope(ctx, uri, 'download');

  const inScope = pagesUnder(await listPages(ctx.url, token), wikiPrefix);
  if (inScope.length === 0) {
    throw new Error(
      `No Wiki.js pages found at or under "${wikiPrefix || '/'}".`
    );
  }

  const stats = newStats();
  out.appendLine(
    `download: "${wikiPrefix || '/'}" — ${inScope.length} remote page(s)`
  );
  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Wiki.js Sync: downloading ${wikiPrefix || '/'}`,
      cancellable: false,
    },
    async (progress) => {
      for (const page of inScope) {
        progress.report({
          message: page.path,
          increment: 100 / inScope.length,
        });
        const filePath = fileForPagePath(ctx, page.path);
        try {
          const full = await getPage(ctx.url, token, page.id);
          await fs.mkdir(path.dirname(filePath), { recursive: true });
          await fs.writeFile(
            filePath,
            serializeSynced(full, full.content),
            'utf8'
          );
          out.appendLine(`download: ${full.path} -> ${filePath}`);
          stats.downloaded++;
        } catch (err: any) {
          stats.failed++;
          out.appendLine(`FAILED ${page.path}: ${err?.message ?? err}`);
        }
      }
    }
  );
  finish(
    out,
    `Wiki.js Sync: downloaded "${wikiPrefix || '/'}" — ${stats.downloaded} page(s)`,
    stats
  );
}

// Two-way sync for a subtree: local .md pushed unless the server copy is newer
// than the last-synced `updatedAt` (then pulled); remote-only pages downloaded;
// eligible non-.md files pushed as assets.
async function syncFolder(
  context: vscode.ExtensionContext,
  out: vscode.OutputChannel,
  uri?: vscode.Uri
) {
  out.show(true);
  const ctx = await resolveContext(uri ?? ambientPath());
  const token = await resolveToken(context, ctx);
  const { folderPath, wikiPrefix } = resolveFolderScope(ctx, uri, 'sync');

  const [localFiles, remotePages] = await Promise.all([
    findMarkdownFiles(folderPath),
    listPages(ctx.url, token),
  ]);
  const eligible = localFiles.filter((f) => fileMatchesContext(ctx, f));
  const remoteInScope = pagesUnder(remotePages, wikiPrefix);
  const remoteByPath = new Map(remoteInScope.map((p) => [p.path, p]));
  const remoteById = new Map(remoteInScope.map((p) => [p.id, p]));
  const matchedRemotePaths = new Set<string>();
  const matchedRemoteIds = new Set<number>();
  const moveResolver = new MoveResolver(true);
  const renameResolver = new RenameResolver(true);
  const renameMode = getSettings().autoRenameIllegalPaths;

  const stats = newStats();
  out.appendLine(
    `sync: "${wikiPrefix || '/'}" — ${eligible.length} local file(s), ${remoteInScope.length} remote page(s)`
  );

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Wiki.js Sync: syncing ${wikiPrefix || '/'}`,
      cancellable: false,
    },
    async (progress) => {
      for (const originalPath of eligible) {
        progress.report({
          message: path.relative(folderPath, originalPath),
          increment: 100 / (eligible.length || 1),
        });

        const legal = await ensureLegalLocation(
          ctx,
          originalPath,
          out,
          renameMode,
          renameResolver
        );
        if (legal === undefined) {
          stats.skipped++;
          continue;
        }
        const filePath = legal;
        const relFilePath = path.relative(folderPath, filePath);

        const text = await fs.readFile(filePath, 'utf8');
        const { meta, content, hadFrontMatter } = parsePageFileLoose(
          text,
          filePath
        );
        if (!hadFrontMatter) {
          out.appendLine(
            `sync: ${relFilePath} had no front matter; generating defaults for first upload`
          );
        }

        meta.path = pagePathForFile(ctx, filePath);

        const pushLocal = (extra?: {
          forceCreate?: boolean;
          adoptId?: number;
        }) =>
          syncUpload(context, out, ctx, filePath, {
            silent: true,
            skipConflictPrompt: true,
            skipRenameCheck: true,
            ...extra,
          });
        const pullRemote = async (id: number, note: string) => {
          const full = await getPage(ctx.url, token, id);
          await fs.writeFile(
            filePath,
            serializeSynced(full, full.content),
            'utf8'
          );
          out.appendLine(
            `sync: downloaded ${full.path} -> ${filePath} ${note}`
          );
        };

        try {
          const remotePath = meta.path;
          const remote = remoteByPath.get(remotePath);
          if (remote) {
            matchedRemotePaths.add(remotePath);
            matchedRemoteIds.add(remote.id);
          }

          // No remote page at this file's location.
          if (!remote) {
            // The file carries an id whose page lives elsewhere on the server:
            // it was moved (rename the page, keep its id/history) or copied from
            // another page (stale id — make it a new page). Ask once; a reorg
            // can answer for everything with "…All".
            if (meta.id && remoteById.has(meta.id)) {
              const from = remoteById.get(meta.id)!;
              const choice = await moveResolver.resolve(
                relFilePath,
                meta.id,
                from.path,
                remotePath
              );
              if (choice === 'skip') {
                stats.conflicts++;
                out.appendLine(
                  `sync: ${relFilePath}: move/copy of page id ${meta.id} unresolved, left untouched`
                );
                continue;
              }
              if (choice === 'move') {
                matchedRemoteIds.add(meta.id);
                await pushLocal();
                stats.uploaded++;
                out.appendLine(
                  `sync: moved page id ${meta.id} "${from.path}" -> "${remotePath}"`
                );
                continue;
              }
              // 'new'
              await pushLocal({ forceCreate: true });
              stats.uploaded++;
              continue;
            }
            // First upload (create).
            await pushLocal();
            stats.uploaded++;
            continue;
          }

          // Three-way sync: compare the file against its last-synced state
          // (syncHash for the body/metadata, updatedAt for the server clock).
          const localChanged =
            !meta.syncHash || pageDigest(meta, content) !== meta.syncHash;
          const remoteChanged = !sameInstant(meta.updatedAt, remote.updatedAt);

          if (!localChanged && !remoteChanged) {
            // Nothing to sync, but an older version may have left a `path:` line
            // (or other non-canonical front matter). Tidy it in place — no
            // network, no history bump (pageDigest ignores everything this
            // rewrites, so syncHash still matches next run).
            if (hadFrontMatter && needsCanonicalRewrite(text, meta, content)) {
              await fs.writeFile(
                filePath,
                serializePageFile(meta, content),
                'utf8'
              );
              stats.tidied++;
              out.appendLine(
                `sync: ${relFilePath} unchanged; tidied front matter`
              );
            } else {
              stats.skipped++;
              out.appendLine(`sync: ${relFilePath} unchanged; skipped`);
            }
            continue;
          }

          if (localChanged && remoteChanged) {
            const choice = await vscode.window.showWarningMessage(
              `Wiki.js Sync: "${remotePath}" changed both locally and on the server since the last sync. Which copy wins?`,
              { modal: true },
              'Upload (keep my local copy)',
              'Download (keep the server copy)'
            );
            if (choice === 'Upload (keep my local copy)') {
              await pushLocal({ adoptId: remote.id });
              stats.uploaded++;
            } else if (choice === 'Download (keep the server copy)') {
              await pullRemote(remote.id, '(conflict; server copy kept)');
              stats.downloaded++;
            } else {
              stats.conflicts++;
              out.appendLine(
                `sync: CONFLICT ${relFilePath}: unresolved, left untouched`
              );
            }
            continue;
          }

          if (remoteChanged) {
            await pullRemote(remote.id, '(server was newer)');
            stats.downloaded++;
          } else {
            await pushLocal({ adoptId: remote.id });
            stats.uploaded++;
          }
        } catch (err: any) {
          stats.failed++;
          out.appendLine(`sync: FAILED ${relFilePath}: ${err?.message ?? err}`);
        }
      }

      for (const [remotePath, page] of remoteByPath) {
        if (matchedRemotePaths.has(remotePath) || matchedRemoteIds.has(page.id))
          continue;
        const filePath = fileForPagePath(ctx, remotePath);
        try {
          const full = await getPage(ctx.url, token, page.id);
          await fs.mkdir(path.dirname(filePath), { recursive: true });
          await fs.writeFile(
            filePath,
            serializeSynced(full, full.content),
            'utf8'
          );
          out.appendLine(
            `sync: downloaded new page ${full.path} -> ${filePath}`
          );
          stats.downloaded++;
        } catch (err: any) {
          stats.failed++;
          out.appendLine(
            `sync: FAILED to download ${remotePath}: ${err?.message ?? err}`
          );
        }
      }

      if (ctx.assets) {
        const assetFiles = (await findAssetFiles(folderPath)).filter((f) =>
          fileMatchesContext(ctx, f)
        );
        const folderCache = new Map<string, number>();
        for (const filePath of assetFiles) {
          const relFilePath = path.relative(folderPath, filePath);
          progress.report({
            message: relFilePath,
            increment: 100 / (assetFiles.length || 1),
          });
          try {
            if (
              await uploadAssetMirrored(ctx, token, filePath, out, folderCache)
            ) {
              stats.assetsUploaded++;
            } else {
              stats.assetsSkipped++;
            }
          } catch (err: any) {
            stats.assetsFailed++;
            out.appendLine(
              `sync: FAILED asset ${relFilePath}: ${err?.message ?? err}`
            );
          }
        }
      }
    }
  );

  finish(
    out,
    `Wiki.js Sync: synced "${wikiPrefix || '/'}" — ${stats.uploaded} uploaded`,
    stats
  );
}

// -- normalize front matter (local only, no network) --------------------

// Rewrite every Markdown file under a folder so its front-matter block is the
// canonical serialization of what it parses to — drops a stale `path:` line left
// by an older version, drops unknown keys, fixes key order and stray blank
// lines. The page body is left byte-for-byte. Touches nothing on the wiki;
// needs no token or URL.
async function normalizeFolder(out: vscode.OutputChannel, uri?: vscode.Uri) {
  out.show(true);
  const folderPath = uri?.fsPath;
  if (!folderPath) {
    throw new Error(
      'Right-click a folder in the Explorer to normalize its front matter.'
    );
  }

  const files = await findMarkdownFiles(folderPath);
  out.appendLine(`normalize: "${folderPath}" — ${files.length} file(s)`);
  let tidied = 0;
  let clean = 0;
  let skipped = 0;
  for (const filePath of files) {
    const rel = path.relative(folderPath, filePath);
    try {
      const text = await fs.readFile(filePath, 'utf8');
      const { meta, content } = parsePageFile(text); // throws if no front matter
      if (needsCanonicalRewrite(text, meta, content)) {
        await fs.writeFile(filePath, serializePageFile(meta, content), 'utf8');
        tidied++;
        out.appendLine(`normalize: rewrote ${rel}`);
      } else {
        clean++;
      }
    } catch (err: any) {
      skipped++;
      out.appendLine(`normalize: skipped ${rel} (${err?.message ?? err})`);
    }
  }

  const summary =
    `Wiki.js Sync: normalized "${folderPath}" — ${tidied} rewritten, ` +
    `${clean} already canonical` +
    (skipped ? `, ${skipped} skipped (no front matter)` : '') +
    '.';
  out.appendLine(summary);
  vscode.window.showInformationMessage(summary);
}

// -- upload-on-save --------------------------------------------------------

async function onSave(
  context: vscode.ExtensionContext,
  out: vscode.OutputChannel,
  doc: vscode.TextDocument
) {
  if (!doc.fileName.endsWith('.md') || doc.uri.scheme !== 'file') return;
  if (!getSettings().uploadOnSave) return;

  let ctx: SyncContext;
  try {
    ctx = await resolveContext(doc.fileName);
  } catch {
    return; // not configured for this file; say nothing on every save
  }
  const rel = path.relative(ctx.root, doc.fileName);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return; // outside this context
  if (!fileMatchesContext(ctx, doc.fileName)) return;

  await guarded(async () => {
    await syncUpload(context, out, ctx, doc.fileName, { silent: true });
  });
}

// -- move / copy resolution ----------------------------------------------

// When a local file carries a page `id` but sits at a path that doesn't match
// where that page lives on the server, it was either moved (rename the page and
// keep its id) or copied from another page (the id is stale — it should become
// its own new page). Only the user knows which. This asks once per file, but
// lets a big reorganisation answer once for everything with a "…all" button.
type MoveChoice = 'move' | 'new' | 'skip';

class MoveResolver {
  private sticky?: MoveChoice;

  /** `batch` enables the "apply to all" buttons (pointless for a single file). */
  constructor(private readonly batch = false) {}

  async resolve(
    fileLabel: string,
    id: number,
    serverPath: string,
    localPath: string
  ): Promise<MoveChoice> {
    if (this.sticky) return this.sticky;

    const buttons = this.batch
      ? ['Move', 'Move All', 'New Page', 'New Page for All']
      : ['Move', 'New Page'];
    const choice = await vscode.window.showWarningMessage(
      `Wiki.js Sync: "${fileLabel}" carries page id ${id}, which is at ` +
        `"${serverPath}" on the server, but the file now lives at "${localPath}". ` +
        `Move the page (keep its id and history), or upload it as a new page ` +
        `(it was copied from another page)?`,
      { modal: true },
      ...buttons
    );
    switch (choice) {
      case 'Move':
        return 'move';
      case 'Move All':
        this.sticky = 'move';
        return 'move';
      case 'New Page':
        return 'new';
      case 'New Page for All':
        this.sticky = 'new';
        return 'new';
      default:
        return 'skip';
    }
  }
}

// -- illegal-path rename resolution -------------------------------------

// Wiki.js rejects a page path containing `.`, a space, `\` or `//`, so a local
// file whose location would produce one has to be renamed before it can sync.
// Asks once per file; a reorg can answer for everything with "…All".
type RenameChoice = 'rename' | 'skip';

class RenameResolver {
  private sticky?: RenameChoice;

  /** `batch` enables the "apply to all" buttons (pointless for a single file). */
  constructor(private readonly batch = false) {}

  async resolve(relFrom: string, relTo: string): Promise<RenameChoice> {
    if (this.sticky) return this.sticky;

    const buttons = this.batch
      ? ['Rename', 'Rename All', 'Skip', 'Skip All']
      : ['Rename', 'Skip'];
    const choice = await vscode.window.showWarningMessage(
      `Wiki.js Sync: "${relFrom}" maps to a Wiki.js page path that Wiki.js won't ` +
        `accept (paths can't contain ".", spaces, "\\" or "//"). Rename the local ` +
        `file to "${relTo}"?`,
      { modal: true },
      ...buttons
    );
    switch (choice) {
      case 'Rename':
        return 'rename';
      case 'Rename All':
        this.sticky = 'rename';
        return 'rename';
      case 'Skip All':
        this.sticky = 'skip';
        return 'skip';
      default:
        return 'skip';
    }
  }
}

// If `filePath`'s location maps to a Wiki.js-legal path, returns it unchanged.
// Otherwise renames the file (honoring `mode`: prompt / auto / off) to the
// sanitized location so local and remote agree and round-trips stay stable, and
// returns the new path — or `undefined` if the file should be skipped this run.
async function ensureLegalLocation(
  ctx: SyncContext,
  filePath: string,
  out: vscode.OutputChannel,
  mode: AutoRenameMode,
  resolver: RenameResolver
): Promise<string | undefined> {
  const legalPath = pagePathForFile(ctx, filePath);
  const target = fileForPagePath(ctx, legalPath);
  if (path.resolve(target) === path.resolve(filePath)) return filePath;

  const relFrom = path.relative(ctx.root, filePath);
  const relTo = path.relative(ctx.root, target);

  if (mode === 'off') {
    out.appendLine(
      `skipped ${relFrom}: location maps to the Wiki.js-illegal path "${legalPath}" ` +
        `(wikijsSync.autoRenameIllegalPaths is "off")`
    );
    return undefined;
  }
  if (mode === 'prompt') {
    if ((await resolver.resolve(relFrom, relTo)) === 'skip') {
      out.appendLine(`skipped ${relFrom}: rename to "${relTo}" declined`);
      return undefined;
    }
  }

  try {
    await fs.access(target);
    out.appendLine(
      `skipped ${relFrom}: cannot rename to "${relTo}" — a file is already there`
    );
    return undefined;
  } catch {
    /* target free */
  }

  await fs.mkdir(path.dirname(target), { recursive: true });
  const edit = new vscode.WorkspaceEdit();
  edit.renameFile(vscode.Uri.file(filePath), vscode.Uri.file(target), {
    overwrite: false,
  });
  if (!(await vscode.workspace.applyEdit(edit))) {
    await fs.rename(filePath, target);
  }
  out.appendLine(`renamed ${relFrom} -> ${relTo} (Wiki.js-legal path)`);
  return target;
}

// -- core upload (create / update one page) -------------------------------

// Serialize uploads per local file so two near-simultaneous triggers can't both
// read the file before either has written the newly-assigned id back to disk.
const uploadLocks = new Map<string, Promise<void>>();

function withFileLock<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
  const prior = uploadLocks.get(filePath) ?? Promise.resolve();
  const run = prior.then(fn, fn);
  uploadLocks.set(
    filePath,
    run.then(
      () => undefined,
      () => undefined
    )
  );
  return run;
}

interface SyncUploadOpts {
  silent: boolean;
  /** Skip the per-file server probe + prompts (the caller already reconciled). */
  skipConflictPrompt?: boolean;
  /** Drop any local `id` and create a fresh page (resolved "copied from"). */
  forceCreate?: boolean;
  /** Force this page id, overriding whatever the file carries (the caller
   * matched the file to an existing page by location). */
  adoptId?: number;
  /** Shared across a batch so "apply to all" sticks. */
  moveResolver?: MoveResolver;
  /** Shared across a batch so the illegal-path "…All" answer sticks. */
  renameResolver?: RenameResolver;
  /** The caller already ran `ensureLegalLocation` (e.g. syncFolder). */
  skipRenameCheck?: boolean;
}

async function syncUpload(
  context: vscode.ExtensionContext,
  out: vscode.OutputChannel,
  ctx: SyncContext,
  filePath: string,
  opts: SyncUploadOpts
) {
  return withFileLock(filePath, () =>
    syncUploadLocked(context, out, ctx, filePath, opts)
  );
}

// Returns true if the page was pushed, false if the file was skipped (an
// unresolved move/copy, a newer server copy, or a declined illegal-path rename).
async function syncUploadLocked(
  context: vscode.ExtensionContext,
  out: vscode.OutputChannel,
  ctx: SyncContext,
  filePath: string,
  opts: SyncUploadOpts
): Promise<boolean> {
  const token = await resolveToken(context, ctx);

  if (!opts.skipRenameCheck) {
    const legal = await ensureLegalLocation(
      ctx,
      filePath,
      out,
      getSettings().autoRenameIllegalPaths,
      opts.renameResolver ?? new RenameResolver(false)
    );
    if (legal === undefined) return false;
    filePath = legal;
  }

  const text = await fs.readFile(filePath, 'utf8');
  const { meta, content, hadFrontMatter } = parsePageFileLoose(text, filePath);
  if (!hadFrontMatter) {
    out.appendLine(
      `note: ${filePath} had no front matter; generated defaults (title: "${meta.title}") for first upload`
    );
  }
  // The page path is always the file's location relative to the sync root — it
  // is never read from the front matter.
  meta.path = pagePathForFile(ctx, filePath);
  if (opts.forceCreate) meta.id = undefined;
  else if (opts.adoptId !== undefined) meta.id = opts.adoptId;

  if (meta.id && !opts.skipConflictPrompt) {
    const stub = await getPageStub(ctx.url, token, meta.id);
    if (stub && stub.path !== meta.path) {
      const choice = await (
        opts.moveResolver ?? new MoveResolver(false)
      ).resolve(path.basename(filePath), meta.id, stub.path, meta.path);
      if (choice === 'skip') {
        out.appendLine(
          `skipped ${filePath}: move/copy of page id ${meta.id} not resolved`
        );
        return false;
      }
      if (choice === 'new') meta.id = undefined;
    }
    if (
      meta.id &&
      stub &&
      meta.updatedAt &&
      !sameInstant(stub.updatedAt, meta.updatedAt)
    ) {
      const choice = await vscode.window.showWarningMessage(
        `Wiki.js Sync: "${meta.path}" was changed on the server since you last synced (server copy updated ${stub.updatedAt}). Overwrite the server copy with your local file?`,
        { modal: true },
        'Overwrite'
      );
      if (choice !== 'Overwrite') {
        out.appendLine(
          `skipped ${meta.path}: server copy is newer, upload cancelled`
        );
        return false;
      }
    }
  }

  if (meta.id) {
    const updated = await updatePage(ctx.url, token, meta.id, meta, content);
    meta.updatedAt = updated.updatedAt;
    await fs.writeFile(filePath, serializeSynced(meta, content), 'utf8');
    out.appendLine(`updated ${meta.path} (id ${meta.id})`);
    if (!opts.silent)
      vscode.window.setStatusBarMessage(`Wiki.js: updated ${meta.path}`, 3000);
    return true;
  }

  let created;
  try {
    created = await createPage(ctx.url, token, meta, content);
  } catch (err: any) {
    if (!String(err?.message ?? err).includes('already exists')) throw err;

    const existing = await getPageByPath(
      ctx.url,
      token,
      meta.path,
      meta.locale
    );
    if (!existing) throw err;

    out.appendLine(
      `create failed because ${meta.path} already exists on the server (id ${existing.id}); adopting that id and updating instead`
    );
    const updated = await updatePage(
      ctx.url,
      token,
      existing.id,
      meta,
      content
    );
    meta.id = existing.id;
    meta.updatedAt = updated.updatedAt;
    await fs.writeFile(filePath, serializeSynced(meta, content), 'utf8');
    out.appendLine(`updated ${meta.path} (id ${meta.id})`);
    if (!opts.silent)
      vscode.window.setStatusBarMessage(`Wiki.js: updated ${meta.path}`, 3000);
    return true;
  }

  meta.id = created.id;
  meta.updatedAt = created.updatedAt;
  await fs.writeFile(filePath, serializeSynced(meta, content), 'utf8');
  out.appendLine(`created ${meta.path} (id ${meta.id})`);
  if (!opts.silent)
    vscode.window.setStatusBarMessage(`Wiki.js: created ${meta.path}`, 3000);
  return true;
}

// -- filesystem walks -----------------------------------------------------

async function findMarkdownFiles(dir: string): Promise<string[]> {
  return walk(dir, (name) => name.endsWith('.md'));
}

async function findAssetFiles(dir: string): Promise<string[]> {
  return walk(dir, (name) => !name.endsWith('.md') && name !== CONFIG_FILENAME);
}

async function walk(
  dir: string,
  keep: (name: string) => boolean
): Promise<string[]> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const results: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...(await walk(full, keep)));
    } else if (entry.isFile() && keep(entry.name)) {
      results.push(full);
    }
  }
  return results;
}
