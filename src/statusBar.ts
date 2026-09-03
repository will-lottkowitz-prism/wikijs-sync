import * as vscode from 'vscode';
import { CONFIG_FILENAME, resolveContext } from './config';

// A status-bar item showing which wiki / path the active Markdown file resolves
// to (parallels the sftp plugin's active-profile indicator). Click to open the
// governing .wikisync.json, or run Set API Token when in legacy mode.

let item: vscode.StatusBarItem | undefined;

const REVEAL_COMMAND = 'wikijsSync.revealConfig';

export function initStatusBar(context: vscode.ExtensionContext): void {
  item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 50);
  item.name = 'Wiki.js Sync';

  context.subscriptions.push(
    item,
    vscode.commands.registerCommand(REVEAL_COMMAND, revealActiveConfig),
    vscode.window.onDidChangeActiveTextEditor(() => refresh()),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('wikijsSync')) refresh();
    })
  );

  refresh();
}

function hostOf(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

async function refresh(): Promise<void> {
  if (!item) return;

  const editor = vscode.window.activeTextEditor;
  const doc = editor?.document;
  if (!doc || doc.uri.scheme !== 'file' || doc.languageId !== 'markdown') {
    item.hide();
    return;
  }

  try {
    const ctx = await resolveContext(doc.uri.fsPath);
    const scope = ctx.configPath
      ? ctx.wikiPath || '/'
      : `${hostOf(ctx.url)} (legacy)`;
    item.text = `$(book) ${scope}`;
    item.tooltip = ctx.configPath
      ? `Wiki.js Sync\n${hostOf(ctx.url)} — this folder maps to "${ctx.wikiPath || '/'}"\nfrom ${ctx.configPath}\nClick to open the .wikisync.json`
      : `Wiki.js Sync\n${hostOf(ctx.url)} — legacy contentDir mirror\nAdd a ${CONFIG_FILENAME} to map a folder`;
    item.command = ctx.configPath ? REVEAL_COMMAND : 'wikijsSync.setToken';
    item.show();
  } catch {
    // not configured for this file - stay out of the way
    item.hide();
  }
}

async function revealActiveConfig(): Promise<void> {
  const doc = vscode.window.activeTextEditor?.document;
  if (!doc) return;
  try {
    const ctx = await resolveContext(doc.uri.fsPath);
    if (ctx.configPath) {
      const opened = await vscode.workspace.openTextDocument(ctx.configPath);
      await vscode.window.showTextDocument(opened);
    }
  } catch {
    /* nothing to reveal */
  }
}
