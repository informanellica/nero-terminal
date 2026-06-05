'use strict';

const vscode = require('vscode');

/**
 * Tree view of saved SSH sessions. Each node carries the session id in
 * `id`/`session`; selecting a node opens its terminal via `neroTerminal.connect`.
 * @implements {vscode.TreeDataProvider<object>}
 */
class SessionTreeProvider {
  /** @param {import('./sessions').SessionStore} store */
  constructor(store) {
    this._store = store;
    this._onDidChangeTreeData = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._onDidChangeTreeData.event;
    store.onDidChange(() => this._onDidChangeTreeData.fire());
  }

  refresh() {
    this._onDidChangeTreeData.fire();
  }

  /** @param {object} session */
  getTreeItem(session) {
    const item = new vscode.TreeItem(session.name || session.host, vscode.TreeItemCollapsibleState.None);
    const who = session.username ? `${session.username}@` : '';
    item.description = `${who}${session.host}:${session.port || 22}`;
    item.iconPath = new vscode.ThemeIcon('vm');
    item.contextValue = 'neroSession';
    item.tooltip = `${item.label} — ${item.description}` + (session.x11 ? ' (X11)' : '');
    item.command = { command: 'neroTerminal.connect', title: 'Open terminal', arguments: [session] };
    return item;
  }

  getChildren() {
    return this._store.list();
  }
}

module.exports = { SessionTreeProvider };
