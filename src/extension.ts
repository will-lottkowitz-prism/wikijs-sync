import * as vscode from 'vscode';
import { registerCommands } from './commands';
import { initStatusBar } from './statusBar';
import { initSelfUpdate } from './selfUpdate';

export function activate(context: vscode.ExtensionContext) {
  registerCommands(context);
  initStatusBar(context);
  initSelfUpdate(context, { configPrefix: 'wikijsSync' });
}

export function deactivate() {}
