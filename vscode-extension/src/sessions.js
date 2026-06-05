'use strict';

const vscode = require('vscode');

const STORE_KEY = 'neroTerminal.sessions';

/**
 * Saved-session store. Non-secret fields live in `globalState`; the password
 * and key passphrase live in VS Code's `SecretStorage`, keyed by session id,
 * so they are never written to settings or synced state.
 */
class SessionStore {
  /** @param {vscode.ExtensionContext} context */
  constructor(context) {
    this._ctx = context;
    /** @type {vscode.EventEmitter<void>} */
    this._onDidChange = new vscode.EventEmitter();
    /** Fires whenever the session list changes. */
    this.onDidChange = this._onDidChange.event;
  }

  /** @returns {Array<object>} the saved sessions (without secrets). */
  list() {
    return this._ctx.globalState.get(STORE_KEY, []);
  }

  /** @param {string} id @returns {object|undefined} */
  get(id) {
    return this.list().find((s) => s.id === id);
  }

  /**
   * Insert or update a session. `password`/`passphrase`, if present, are moved
   * into SecretStorage and stripped from the persisted record.
   * @param {object} session
   */
  async save(session) {
    const { password, passphrase, ...rest } = session;
    const list = this.list();
    const i = list.findIndex((s) => s.id === rest.id);
    if (i === -1) list.push(rest); else list[i] = rest;
    await this._ctx.globalState.update(STORE_KEY, list);
    if (password !== undefined) await this._setSecret(rest.id, 'password', password);
    if (passphrase !== undefined) await this._setSecret(rest.id, 'passphrase', passphrase);
    this._onDidChange.fire();
  }

  /** @param {string} id */
  async remove(id) {
    const list = this.list().filter((s) => s.id !== id);
    await this._ctx.globalState.update(STORE_KEY, list);
    await this._ctx.secrets.delete(secretKey(id, 'password'));
    await this._ctx.secrets.delete(secretKey(id, 'passphrase'));
    this._onDidChange.fire();
  }

  /** @param {string} id @returns {Promise<{password?:string, passphrase?:string}>} */
  async secrets(id) {
    return {
      password: await this._ctx.secrets.get(secretKey(id, 'password')) || undefined,
      passphrase: await this._ctx.secrets.get(secretKey(id, 'passphrase')) || undefined,
    };
  }

  async _setSecret(id, name, value) {
    if (value) await this._ctx.secrets.store(secretKey(id, name), value);
    else await this._ctx.secrets.delete(secretKey(id, name));
  }
}

function secretKey(id, name) {
  return `${STORE_KEY}:${id}:${name}`;
}

module.exports = { SessionStore };
