'use strict';

/**
 * @file Session manager — the PuTTY-style session config & lifecycle for
 * nero-terminal, in the main process.
 *
 * Opens either a remote **SSH** session ({@link SshHost} / ssh2) or a **local**
 * shell ({@link PtyHost} / node-pty); both implement the same host interface, so
 * the same terminal-lib IPC bridge (`attachPtyToIpc`) serves either backend. Also
 * detects local shells and persists "Saved Sessions" to `userData/sessions.json`.
 *
 * Extracted from {@link module:main/main} so it can be exercised headlessly by
 * `scripts/session-smoke.js`.
 *
 * @module main/session-manager
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const { PtyHost } = require('../nero_modules/terminal/src/backend/pty-host');
const { SshHost } = require('../nero_modules/terminal/src/backend/ssh-host');
const { attachPtyToIpc } = require('../nero_modules/terminal/src/transport/electron-main');

/**
 * A local shell offered under the "Local" connection type.
 * @typedef {object} ShellDescriptor
 * @property {string} id      Stable identifier (e.g. `'powershell'`, `'wsl'`, `'gitbash'`).
 * @property {string} label   Human-readable name shown in the dropdown.
 * @property {string} shell   Executable to spawn.
 * @property {string[]} args  Default arguments for that shell.
 */

/**
 * Options accepted by {@link openSession} (and `window.sessionAPI.open`).
 * @typedef {object} SessionOptions
 * @property {'ssh'|'local'} [type='ssh']  Connection type.
 * @property {number} [cols=120]
 * @property {number} [rows=32]
 * @property {string} [host]        SSH: host name or IP.
 * @property {number} [port=22]     SSH: port.
 * @property {string} [username]    SSH: login user (else prompted in-terminal).
 * @property {string} [password]    SSH: password (else prompted in-terminal).
 * @property {string} [keyPath]     SSH: path to a private key file, read by main.
 * @property {string} [passphrase]  SSH: key passphrase.
 * @property {string} [term='xterm-256color']  SSH: TERM string.
 * @property {string} [shell]       Local: executable to spawn.
 * @property {string[]} [args]      Local: shell arguments.
 * @property {string} [cwd]         Local: working directory (defaults to home).
 * @property {Object<string,string>} [env]  Local: extra environment variables.
 */

/**
 * Result of {@link openSession}.
 * @typedef {object} SessionResult
 * @property {number|null} pid     OS process id for a local PTY; `null` for SSH.
 * @property {'ssh'|'local'} type  The connection type that was opened.
 */

/**
 * A saved session (PuTTY "Saved Sessions"). A superset of {@link SessionOptions}
 * plus presentation fields; secrets (`password`, `passphrase`) are never persisted.
 * @typedef {object} SessionProfile
 * @property {string} name
 * @property {'ssh'|'local'} type
 * @property {string} [host]
 * @property {number} [port]
 * @property {string} [username]
 * @property {string} [keyPath]
 * @property {string} [shellId]
 * @property {number} [cols]
 * @property {number} [rows]
 * @property {number} [scrollback]
 * @property {string} [fontFamily]
 * @property {number} [fontSize]
 * @property {string} [theme]
 */

/**
 * The object returned by {@link createSessionManager}.
 * @typedef {object} SessionManager
 * @property {function(): void} register       Register all `session:*` / `profiles:*` IPC handlers.
 * @property {function(SessionOptions): SessionResult} openSession  Open a session directly (used by smokes).
 * @property {function(): void} closeSession   Dispose the active session.
 * @property {function(): Array<ShellDescriptor>} detectShells
 * @property {function(): Array<SessionProfile>} loadProfiles  Read the saved profiles.
 */

/**
 * Return the first path in `paths` that exists, else `null`.
 * @param {string[]} paths
 * @returns {string|null}
 */
function firstExisting(paths) {
  for (const p of paths) { try { if (p && fs.existsSync(p)) return p; } catch (_) {} }
  return null;
}

/**
 * Detect the local shells available on this machine (for the "Local" connection
 * type). On Windows: PowerShell, pwsh 7 (if present), Command Prompt, WSL (if
 * present), Git Bash (if present). Elsewhere: `$SHELL` plus common alternatives.
 * @returns {ShellDescriptor[]}
 */
function detectShells() {
  const shells = [];
  if (process.platform === 'win32') {
    const sysRoot = process.env.SystemRoot || 'C:\\Windows';
    shells.push({ id: 'powershell', label: 'Windows PowerShell', shell: 'powershell.exe', args: [] });
    const pwsh = firstExisting([
      'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
      path.join(process.env.LOCALAPPDATA || '', 'Microsoft\\PowerShell\\7\\pwsh.exe'),
    ]);
    if (pwsh) shells.push({ id: 'pwsh', label: 'PowerShell 7 (pwsh)', shell: pwsh, args: [] });
    shells.push({ id: 'cmd', label: 'Command Prompt', shell: 'cmd.exe', args: [] });
    const wsl = firstExisting([path.join(sysRoot, 'System32\\wsl.exe')]);
    if (wsl) shells.push({ id: 'wsl', label: 'WSL (bash)', shell: wsl, args: [] });
    const gitBash = firstExisting([
      'C:\\Program Files\\Git\\bin\\bash.exe',
      'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
    ]);
    if (gitBash) shells.push({ id: 'gitbash', label: 'Git Bash', shell: gitBash, args: ['-i', '-l'] });
  } else {
    const sh = process.env.SHELL || '/bin/bash';
    shells.push({ id: 'default', label: `Default shell (${path.basename(sh)})`, shell: sh, args: [] });
    for (const cand of ['/bin/bash', '/bin/zsh', '/bin/sh']) {
      if (cand !== sh && firstExisting([cand])) {
        shells.push({ id: path.basename(cand), label: path.basename(cand), shell: cand, args: [] });
      }
    }
  }
  return shells;
}

/**
 * Create a session manager bound to a single window. Holds at most one live
 * session (a host + its IPC bridge) at a time.
 *
 * @param {object} deps
 * @param {Electron.App} deps.app           Used for `userData` (saved sessions path).
 * @param {Electron.IpcMain} deps.ipcMain   Where the handlers and the PTY bridge attach.
 * @param {Electron.Dialog} deps.dialog     For the directory / key-file pickers.
 * @param {function(): (Electron.BrowserWindow|null)} deps.getWindow  Returns the target window.
 * @param {function(Array<SessionProfile>): void} [deps.onProfilesChanged]
 *   Called with the new list whenever saved profiles change (to refresh the jump list).
 * @returns {SessionManager}
 */
function createSessionManager({ app, ipcMain, dialog, getWindow, onProfilesChanged }) {
  // active terminal-lib IPC bridge, or null
  /** @type {?{dispose: function(): void}} */
  let bridge = null;
  // active backend host (local PTY or remote SSH), or null
  /** @type {?(PtyHost|SshHost)} */
  let host = null;

  const profilesPath = () => path.join(app.getPath('userData'), 'sessions.json');
  const loadProfiles = () => {
    try { return JSON.parse(fs.readFileSync(profilesPath(), 'utf8')); } catch (_) { return []; }
  };
  const saveProfiles = (list) => {
    fs.mkdirSync(path.dirname(profilesPath()), { recursive: true });
    fs.writeFileSync(profilesPath(), JSON.stringify(list, null, 2));
    return list;
  };

  /** Dispose the active session — the IPC bridge and its backend host, if any. */
  function closeSession() {
    if (bridge) { bridge.dispose(); bridge = null; }
    host = null;
  }

  /**
   * Open a session and wire it to the renderer's terminal via the terminal-lib
   * IPC bridge (`attachPtyToIpc`). Any existing session is closed first.
   *
   * For `type: 'ssh'` a {@link SshHost} is created (a `keyPath` is read into a
   * private-key buffer here); for `type: 'local'` a {@link PtyHost} is spawned.
   *
   * @param {SessionOptions} [opts={}]
   * @returns {SessionResult}
   * @throws {Error} if there is no window, or a given key file cannot be read.
   */
  function openSession(opts = {}) {
    const win = getWindow();
    if (!win) throw new Error('no window');
    closeSession();
    const cols = opts.cols || 120;
    const rows = opts.rows || 32;

    if ((opts.type || 'ssh') === 'ssh') {
      let privateKey;
      if (opts.keyPath && String(opts.keyPath).trim()) {
        try { privateKey = fs.readFileSync(opts.keyPath); }
        catch (e) { throw new Error('Cannot read key file: ' + e.message); }
      }
      host = new SshHost({
        host: opts.host, port: opts.port || 22, username: opts.username,
        password: opts.password || undefined, privateKey, passphrase: opts.passphrase || undefined,
        term: opts.term || 'xterm-256color', cols, rows, x11: !!opts.x11,
      });
    } else {
      const env = Object.assign({}, process.env);
      if (opts.env && typeof opts.env === 'object') Object.assign(env, opts.env);
      host = new PtyHost({
        shell: opts.shell || undefined,
        args: Array.isArray(opts.args) ? opts.args : [],
        cwd: opts.cwd && String(opts.cwd).trim() ? opts.cwd : (os.homedir() || process.cwd()),
        cols, rows, env,
      });
    }

    bridge = attachPtyToIpc({ ptyHost: host, ipcMain, webContents: win.webContents });
    return { pid: host.pid, type: opts.type || 'ssh' };
  }

  /**
   * Register every renderer-facing IPC handler on `ipcMain`:
   * `session:detectShells`, `session:browseDir`, `session:browseKey`,
   * `session:open`, `session:close`, and `profiles:list` / `profiles:save` /
   * `profiles:delete`. Call once at startup.
   */
  function register() {
    ipcMain.handle('session:detectShells', () => detectShells());
    ipcMain.handle('session:browseDir', async () => {
      const r = await dialog.showOpenDialog(getWindow(), { properties: ['openDirectory'] });
      return r.canceled || !r.filePaths.length ? null : r.filePaths[0];
    });
    ipcMain.handle('session:browseKey', async () => {
      const r = await dialog.showOpenDialog(getWindow(), {
        title: 'Select private key', properties: ['openFile'],
        filters: [{ name: 'Private keys', extensions: ['pem', 'ppk', 'key', 'openssh', '*'] }],
      });
      return r.canceled || !r.filePaths.length ? null : r.filePaths[0];
    });
    ipcMain.handle('session:open', (_e, opts) => openSession(opts));
    ipcMain.handle('session:close', () => { closeSession(); return true; });
    ipcMain.handle('profiles:list', () => loadProfiles());
    ipcMain.handle('profiles:save', (_e, profile) => {
      const list = loadProfiles();
      const i = list.findIndex((p) => p.name === profile.name);
      if (i >= 0) list[i] = profile; else list.push(profile);
      const saved = saveProfiles(list);
      if (onProfilesChanged) onProfilesChanged(saved);
      return saved;
    });
    ipcMain.handle('profiles:delete', (_e, name) => {
      const saved = saveProfiles(loadProfiles().filter((p) => p.name !== name));
      if (onProfilesChanged) onProfilesChanged(saved);
      return saved;
    });
  }

  return { register, openSession, closeSession, detectShells, loadProfiles };
}

/**
 * Build a Windows taskbar jump list from saved session profiles, for
 * `app.setJumpList()`. Each entry relaunches the app with
 * `--open-profile="<name>"` so the running instance opens that saved session.
 * Returns an empty array when there are no profiles (which clears the list).
 * @param {string} execPath   Path to the app executable (`process.execPath`).
 * @param {Array<SessionProfile>} profiles  Saved profiles to list.
 * @param {string} [iconPath]  Icon shown for each jump-list entry.
 * @returns {Array<object>}    Categories for `app.setJumpList()`.
 */
function buildJumpList(execPath, profiles, iconPath) {
  const list = Array.isArray(profiles) ? profiles : [];
  if (!list.length) return [];
  const items = list.slice(0, 20).map((p) => ({
    type: 'task',
    title: p.name,
    description: p.type === 'local' ? '(local shell)' : (p.host ? p.host : '(SSH)'),
    program: execPath,
    args: `--open-profile=${JSON.stringify(p.name)}`,
    iconPath: iconPath || execPath,
    iconIndex: 0,
  }));
  return [{ type: 'custom', name: 'Saved Sessions', items }];
}

module.exports = { createSessionManager, detectShells, buildJumpList };
