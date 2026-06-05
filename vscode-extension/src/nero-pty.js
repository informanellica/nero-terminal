'use strict';

const fs = require('fs');
const vscode = require('vscode');
// Reuse the exact SSH backend that powers the desktop app (nero-terminal-lib).
// esbuild bundles this (and its ssh2 dependency) into dist/extension.js.
const { SshHost } = require('../../src/nero_modules/terminal/src/backend/ssh-host.js');

/**
 * A {@link vscode.Pseudoterminal} backed by {@link SshHost}. VS Code owns the
 * terminal UI (its own renderer, scrollback, links); we only shuttle bytes
 * between it and the SSH stream — no webview, no xterm, no node-pty.
 */
class NeroPseudoterminal {
  /**
   * @param {object} session  saved session (host/port/username/authType/keyPath/x11/term)
   * @param {{password?:string, passphrase?:string}} secrets  resolved secrets
   */
  constructor(session, secrets) {
    this._session = session;
    this._secrets = secrets || {};
    this._host = null;

    this._writeEmitter = new vscode.EventEmitter();
    this._closeEmitter = new vscode.EventEmitter();
    /** @type {vscode.Event<string>} */
    this.onDidWrite = this._writeEmitter.event;
    /** @type {vscode.Event<number|void>} */
    this.onDidClose = this._closeEmitter.event;
  }

  /** @param {vscode.TerminalDimensions=} dims */
  open(dims) {
    const s = this._session;
    const cols = (dims && dims.columns) || 80;
    const rows = (dims && dims.rows) || 24;

    let privateKey;
    if (s.authType === 'key' && s.keyPath) {
      try {
        privateKey = fs.readFileSync(s.keyPath);
      } catch (e) {
        this._writeEmitter.fire(`\r\n*** Cannot read key file ${s.keyPath}: ${e.message} ***\r\n`);
        this._closeEmitter.fire(1);
        return;
      }
    }

    this._host = new SshHost({
      host: s.host,
      port: s.port || 22,
      username: s.username || undefined,
      password: s.authType === 'password' ? this._secrets.password : undefined,
      privateKey,
      passphrase: this._secrets.passphrase,
      term: s.term || 'xterm-256color',
      x11: !!s.x11,
      cols,
      rows,
    });

    // SshHost emits decoded UTF-8 strings; VS Code's pty wants \r\n line ends,
    // which the SSH server already provides, so forward verbatim.
    this._host.on('data', (d) => this._writeEmitter.fire(d));
    this._host.on('exit', (info) => this._closeEmitter.fire((info && info.exitCode) || 0));
    this._host.start();
  }

  /** @param {string} data */
  handleInput(data) {
    if (this._host) this._host.write(data);
  }

  /** @param {vscode.TerminalDimensions} dims */
  setDimensions(dims) {
    if (this._host && dims) this._host.resize(dims.columns, dims.rows);
  }

  close() {
    if (this._host) { this._host.dispose(); this._host = null; }
  }
}

module.exports = { NeroPseudoterminal };
