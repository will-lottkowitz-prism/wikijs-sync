import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import { normalizeWikiPath } from './pathmap';

/**
 * In-folder config file. Drop one in (say) a project's `docs/` folder to map
 * that folder to a specific Wiki.js path, choose which files sync, and (rarely)
 * point at a different wiki / token than the global settings.
 *
 * If it carries a `token`, add it to `.gitignore`.
 */
export const CONFIG_FILENAME = '.wikisync.json';

const SETTINGS_SECTION = 'wikijsSync';
const TOKEN_KEY = 'wikijsSync.token';

export interface WikiSyncFile {
  /** Wiki.js base URL. Overrides the `wikijsSync.url` setting. */
  url?: string;
  /** API token override for this subtree. Overrides settings / SecretStorage. */
  token?: string;
  /**
   * The Wiki.js path that the folder holding this file maps to. A file at
   * `<thisFolder>/guide/intro.md` becomes wiki page `<wikiPath>/guide/intro`.
   * Omit or "" to map the folder to the wiki root.
   */
  wikiPath?: string;
  /**
   * How non-`.md` files under the folder are treated:
   *  - true  (default): uploaded as assets, mirroring their path
   *  - false: ignored entirely (only `.md` files sync)
   */
  assets?: boolean;
  /** Whitelist: only files matching one of these globs sync. */
  include?: string[];
  /** Ignorelist: files matching one of these globs never sync. */
  exclude?: string[];
}

export interface WikiSyncSettings {
  url: string;
  contentDir: string;
  uploadOnSave: boolean;
  tokenSetting: string;
  defaultAssets: boolean;
  defaultExclude: string[];
}

export interface SyncContext {
  /** Absolute path of the folder that maps to `wikiPath`. */
  root: string;
  /** Wiki path prefix `root` maps to. '' = wiki root. No leading/trailing slash. */
  wikiPath: string;
  /** Resolved Wiki.js base URL. */
  url: string;
  /** true = non-`.md` files upload as assets; false = only `.md` files sync. */
  assets: boolean;
  /** Whitelist globs (undefined = allow everything not excluded). */
  include?: string[];
  /** Ignorelist globs. */
  exclude: string[];
  /** The `.wikisync.json` this came from, if any (legacy contentDir mode = undefined). */
  configPath?: string;
  /** Token from the `.wikisync.json`, if it set one. */
  fileToken?: string;
}

export function getSettings(): WikiSyncSettings {
  const cfg = vscode.workspace.getConfiguration(SETTINGS_SECTION);
  return {
    url: cfg.get<string>('url', '').trim(),
    contentDir: cfg.get<string>('contentDir', 'content'),
    uploadOnSave: cfg.get<boolean>('uploadOnSave', false),
    tokenSetting: cfg.get<string>('token', '').trim(),
    defaultAssets: cfg.get<boolean>('syncNonMarkdownAsAssets', true),
    defaultExclude: cfg.get<string[]>('exclude', [
      '**/.*',
      '**/node_modules/**',
    ]),
  };
}

function workspaceRootFor(fsPath: string): string | undefined {
  const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(fsPath));
  if (folder) return folder.uri.fsPath;
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

/** The folder to begin the walk-up from: a directory as-is, else a file's parent. */
function startDir(fsPath: string): string {
  try {
    if (fs.statSync(fsPath).isDirectory()) return fsPath;
  } catch {
    /* missing/unreadable - fall through */
  }
  return path.dirname(fsPath);
}

/** Nearest `.wikisync.json` walking up from `fsPath` to the workspace root. */
export function findConfigFile(fsPath: string): string | undefined {
  const root = workspaceRootFor(fsPath);
  let dir = startDir(fsPath);
  for (;;) {
    const candidate = path.join(dir, CONFIG_FILENAME);
    if (fs.existsSync(candidate)) return candidate;
    if (root && path.relative(root, dir) === '') break;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

export async function readConfigFile(
  configPath: string
): Promise<WikiSyncFile> {
  let raw: string;
  try {
    raw = await fsp.readFile(configPath, 'utf8');
  } catch (err: any) {
    throw new Error(`Could not read ${configPath}: ${err?.message ?? err}`);
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('expected a JSON object');
    }
    return parsed as WikiSyncFile;
  } catch (err: any) {
    throw new Error(
      `${CONFIG_FILENAME} at ${configPath} is not valid JSON: ${err?.message ?? err}`
    );
  }
}

/**
 * Resolve the sync context for a file or folder:
 *  - the nearest `.wikisync.json` walking up to the workspace root, or
 *  - failing that, legacy mode: the `wikijsSync.contentDir` folder mapped to the
 *    wiki root (today's behavior).
 */
export async function resolveContext(
  target: vscode.Uri | string
): Promise<SyncContext> {
  const fsPath = typeof target === 'string' ? target : target.fsPath;
  const settings = getSettings();

  const configPath = findConfigFile(fsPath);
  if (configPath) {
    const file = await readConfigFile(configPath);
    const url = (file.url ?? settings.url).trim();
    if (!url) {
      throw new Error(
        `No wiki URL: set "url" in ${configPath} or the "wikijsSync.url" setting.`
      );
    }
    return {
      root: path.dirname(configPath),
      wikiPath: normalizeWikiPath(file.wikiPath),
      url,
      assets: file.assets ?? settings.defaultAssets,
      include: file.include,
      exclude: file.exclude ?? settings.defaultExclude,
      configPath,
      fileToken: file.token?.trim() || undefined,
    };
  }

  return legacyContext(fsPath, settings);
}

/**
 * The "whole wiki mirror" context: `wikijsSync.contentDir` mapped to the wiki
 * root. Used by the *All Pages* commands regardless of any `.wikisync.json`.
 */
export function resolveLegacyContext(
  target?: vscode.Uri | string
): SyncContext {
  const fsPath =
    typeof target === 'string'
      ? target
      : (target?.fsPath ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath);
  if (!fsPath) {
    throw new Error('Open a workspace folder before using Wiki.js Sync.');
  }
  return legacyContext(fsPath, getSettings());
}

function legacyContext(
  fsPath: string,
  settings: WikiSyncSettings
): SyncContext {
  if (!settings.url) {
    throw new Error(
      'No wiki configured: add a .wikisync.json next to your Markdown, or set "wikijsSync.url" in Settings.'
    );
  }
  const wsRoot = workspaceRootFor(fsPath);
  if (!wsRoot) {
    throw new Error('Open a workspace folder before using Wiki.js Sync.');
  }
  const contentDir = path.isAbsolute(settings.contentDir)
    ? settings.contentDir
    : path.join(wsRoot, settings.contentDir);

  return {
    root: contentDir,
    wikiPath: '',
    url: settings.url,
    assets: settings.defaultAssets,
    include: undefined,
    exclude: settings.defaultExclude,
  };
}

/** Resolve the API token: `.wikisync.json` > SecretStorage > `wikijsSync.token` setting. */
export async function resolveToken(
  extensionContext: vscode.ExtensionContext,
  ctx: SyncContext
): Promise<string> {
  if (ctx.fileToken) return ctx.fileToken;
  const stored = await extensionContext.secrets.get(TOKEN_KEY);
  if (stored) return stored;
  const setting = getSettings().tokenSetting;
  if (setting) return setting;
  throw new Error(
    'No Wiki.js API token. Run "Wiki.js Sync: Set API Token", set "wikijsSync.token" in Settings, ' +
      `or add "token" to a ${CONFIG_FILENAME}.`
  );
}

// Local <-> wiki-page path mapping and glob matching live in `pathmap.ts` (pure,
// unit-tested). Re-exported here so callers have a single import.
export {
  assetDirForFile,
  assetLinkForFile,
  fileForPagePath,
  fileMatchesContext,
  pagePathForFile,
} from './pathmap';
