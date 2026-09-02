// ============================================================================
// Self-updater — for sideloaded / air-gapped installs.
//
// A sideloaded / air-gapped extension has no Marketplace behind it, so it never
// learns about a newer build. This polls a small JSON manifest (one or more
// "feeds" — an http(s) URL or a local synced folder), and when it names a newer
// version of *this* extension, downloads that .vsix, verifies its sha256 and
// installs it via the built-in `workbench.extensions.installExtension` command,
// then offers a window reload. Everything is best-effort: any failure is logged
// to an output channel and never propagates into activate().
// ============================================================================
import * as vscode from 'vscode';
import * as http from 'http';
import * as https from 'https';
import * as fs from 'fs';
import * as crypto from 'crypto';
import * as path from 'path';
import { URL } from 'url';

interface ManifestEntry {
  version: string;
  vsix: string;
  sha256?: string;
  notes?: string;
}
interface Manifest {
  extensions?: { [extensionId: string]: ManifestEntry };
}

export interface SelfUpdateOptions {
  /** The settings section for this extension, e.g. `wikijsSync` or `sftp`. */
  configPrefix: string;
}

const LAST_CHECK_KEY = 'selfUpdate.lastCheck';
const INSTALLED_VERSION_KEY = 'selfUpdate.installedVersion';
const HTTP_TIMEOUT_MS = 15000;

export function initSelfUpdate(
  context: vscode.ExtensionContext,
  opts: SelfUpdateOptions
): void {
  // Needs the Node extension host (fs / http / crypto). A web-worker host has
  // none of that — and can't sideload a .vsix anyway — so do nothing there.
  const proc: { versions?: { node?: string } } | undefined =
    typeof process === 'undefined' ? undefined : process;
  if (!proc || !proc.versions || !proc.versions.node) {
    return;
  }

  const name = displayName(context);
  const out = vscode.window.createOutputChannel(`${name} — Updates`);
  context.subscriptions.push(out);

  const run = (manual: boolean): Thenable<void> =>
    checkForUpdate(context, opts.configPrefix, out, manual).then(
      undefined,
      (err) => {
        out.appendLine(`[${stamp()}] check failed: ${errText(err)}`);
        if (manual) {
          void vscode.window.showWarningMessage(
            `${name}: update check failed — ${errText(err)}`
          );
        }
      }
    );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      `${opts.configPrefix}.checkForUpdates`,
      () => run(true)
    )
  );

  // Fire-and-forget on startup (throttled inside checkForUpdate).
  void run(false);
}

async function checkForUpdate(
  context: vscode.ExtensionContext,
  prefix: string,
  out: vscode.OutputChannel,
  manual: boolean
): Promise<void> {
  // Never auto-update a build you're actively developing; the manual command
  // still works so it can be tested.
  if (!manual && context.extensionMode !== vscode.ExtensionMode.Production) {
    return;
  }

  const cfg = vscode.workspace.getConfiguration(prefix);
  const mode = cfg.get<string>('autoUpdate', 'auto');
  if (!manual && mode === 'off') {
    return;
  }

  const intervalHours = cfg.get<number>('updateCheckIntervalHours', 6);
  const now = Date.now();
  const last = context.globalState.get<number>(LAST_CHECK_KEY, 0);
  if (
    !manual &&
    intervalHours > 0 &&
    now - last < intervalHours * 3600 * 1000
  ) {
    return;
  }
  await context.globalState.update(LAST_CHECK_KEY, now);

  const feeds = (cfg.get<string[]>('updateFeeds', []) || []).filter(Boolean);
  if (feeds.length === 0) {
    if (manual) {
      void vscode.window.showInformationMessage(
        `${displayName(context)}: no update feeds configured (${prefix}.updateFeeds).`
      );
    }
    return;
  }

  const id = context.extension.id;
  const current = String(context.extension.packageJSON.version);
  out.appendLine(`[${stamp()}] checking ${id} (have ${current})`);

  let found:
    { entry: ManifestEntry; base: string; isHttp: boolean } | undefined;
  for (const feed of feeds) {
    try {
      const loaded = await loadFeed(feed);
      const manifest = JSON.parse(loaded.text) as Manifest;
      const entry = findEntry(manifest, id);
      if (entry && entry.version && entry.vsix) {
        found = { entry, base: loaded.base, isHttp: loaded.isHttp };
        out.appendLine(`  ${feed} -> ${entry.version}`);
        break;
      }
      out.appendLine(`  ${feed}: no entry for ${id}`);
    } catch (err) {
      out.appendLine(`  ${feed}: ${errText(err)}`);
    }
  }

  if (!found) {
    if (manual) {
      void vscode.window.showInformationMessage(
        `${displayName(context)}: no update information found.`
      );
    }
    return;
  }

  const target = found.entry.version;
  if (cmpSemver(target, current) <= 0) {
    if (manual) {
      void vscode.window.showInformationMessage(
        `${displayName(context)} is up to date (${current}).`
      );
    }
    return;
  }

  if (context.globalState.get<string>(INSTALLED_VERSION_KEY) === target) {
    out.appendLine(
      `  v${target} already installed this session; reload to apply.`
    );
    await promptReload(displayName(context), target);
    return;
  }

  if (mode === 'prompt' || (manual && mode === 'off')) {
    const pick = await vscode.window.showInformationMessage(
      `${displayName(context)} ${target} is available (you have ${current}).`,
      'Update Now',
      'Release Notes',
      'Skip'
    );
    if (pick === 'Release Notes') {
      showNotes(out, found.entry);
      return;
    }
    if (pick !== 'Update Now') {
      return;
    }
  }

  await doUpdate(context, out, found, target);
}

async function doUpdate(
  context: vscode.ExtensionContext,
  out: vscode.OutputChannel,
  found: { entry: ManifestEntry; base: string; isHttp: boolean },
  target: string
): Promise<void> {
  const { entry, base, isHttp } = found;

  let bytes: Buffer;
  if (isHttp) {
    const url = joinUrl(base, entry.vsix);
    out.appendLine(`  downloading ${url}`);
    bytes = await httpGetBuffer(url);
  } else {
    const src = path.join(base, entry.vsix);
    out.appendLine(`  reading ${src}`);
    bytes = await fs.promises.readFile(src);
  }

  if (entry.sha256) {
    const got = crypto.createHash('sha256').update(bytes).digest('hex');
    if (got.toLowerCase() !== entry.sha256.toLowerCase()) {
      throw new Error(
        `sha256 mismatch for ${entry.vsix}: manifest ${entry.sha256}, got ${got}`
      );
    }
  }

  const dir = context.globalStorageUri.fsPath;
  await fs.promises.mkdir(dir, { recursive: true });
  const vsixPath = path.join(dir, entry.vsix);
  await fs.promises.writeFile(vsixPath, bytes);

  out.appendLine(`  installing ${vsixPath}`);
  await vscode.commands.executeCommand(
    'workbench.extensions.installExtension',
    vscode.Uri.file(vsixPath)
  );
  await context.globalState.update(INSTALLED_VERSION_KEY, target);
  out.appendLine(`[${stamp()}] installed v${target}; reload required.`);
  await promptReload(displayName(context), target);
}

async function promptReload(name: string, version: string): Promise<void> {
  const pick = await vscode.window.showInformationMessage(
    `${name} updated to ${version}. Reload to apply.`,
    'Reload Window'
  );
  if (pick === 'Reload Window') {
    await vscode.commands.executeCommand('workbench.action.reloadWindow');
  }
}

function showNotes(out: vscode.OutputChannel, entry: ManifestEntry): void {
  out.appendLine('');
  out.appendLine(`--- ${entry.version} ---`);
  out.appendLine(
    entry.notes && entry.notes.trim() ? entry.notes.trim() : '(no notes)'
  );
  out.show(true);
}

// -- helpers ----------------------------------------------------------------

function findEntry(manifest: Manifest, id: string): ManifestEntry | undefined {
  const map = manifest.extensions;
  if (!map) {
    return undefined;
  }
  if (map[id]) {
    return map[id];
  }
  // VS Code lower-cases extension ids in some contexts; match loosely.
  const lower = id.toLowerCase();
  for (const key of Object.keys(map)) {
    if (key.toLowerCase() === lower) {
      return map[key];
    }
  }
  return undefined;
}

function cmpSemver(a: string, b: string): number {
  const pa = String(a).split('-')[0].split('.');
  const pb = String(b).split('-')[0].split('.');
  for (let i = 0; i < 3; i++) {
    const d = (parseInt(pa[i], 10) || 0) - (parseInt(pb[i], 10) || 0);
    if (d !== 0) {
      return d < 0 ? -1 : 1;
    }
  }
  return 0;
}

async function loadFeed(
  feed: string
): Promise<{ text: string; base: string; isHttp: boolean }> {
  if (/^https?:\/\//i.test(feed)) {
    const text = (await httpGetBuffer(feed)).toString('utf8');
    // base = the feed URL with its last path segment removed.
    const u = new URL(feed);
    u.pathname = u.pathname.replace(/[^/]*$/, '');
    return { text, base: u.toString(), isHttp: true };
  }
  const p = feed.replace(/^file:\/\//, '');
  const text = await fs.promises.readFile(p, 'utf8');
  return { text, base: path.dirname(p), isHttp: false };
}

function joinUrl(base: string, file: string): string {
  return base.replace(/\/*$/, '/') + file.replace(/^\/*/, '');
}

function httpGetBuffer(rawUrl: string, redirects = 0): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    if (redirects > 5) {
      reject(new Error('too many redirects'));
      return;
    }
    let u: URL;
    try {
      u = new URL(rawUrl);
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.get(u, (res) => {
      const status = res.statusCode || 0;
      const location = res.headers.location;
      if (status >= 300 && status < 400 && location) {
        res.resume();
        resolve(httpGetBuffer(new URL(location, u).toString(), redirects + 1));
        return;
      }
      if (status !== 200) {
        res.resume();
        reject(new Error(`HTTP ${status} for ${rawUrl}`));
        return;
      }
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(HTTP_TIMEOUT_MS, () => {
      req.destroy(new Error('request timed out'));
    });
  });
}

function displayName(context: vscode.ExtensionContext): string {
  const pkg = context.extension.packageJSON as { displayName?: string };
  return pkg.displayName || context.extension.id;
}

function errText(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}

function stamp(): string {
  return new Date().toISOString().replace('T', ' ').replace(/\..*/, '');
}
