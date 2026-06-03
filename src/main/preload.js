'use strict';

/**
 * @file Preload script — the **only** bridge between the sandboxed renderer and
 * the main process. Runs with Node access but `contextIsolation` on, and exposes
 * three frozen API objects on `window`:
 *
 * - `window.terminalAPI` — raw PTY/SSH byte flow (provided by the terminal lib's
 *   {@link https://|exposeTerminalBridge}): `sendInput`, `resize`, `onData`, `onExit`;
 * - `window.windowAPI` — see {@link WindowAPI};
 * - `window.sessionAPI` — see {@link SessionAPI}.
 *
 * Everything the renderer can ask the main process to do is enumerated here.
 * @module main/preload
 */

const { contextBridge, ipcRenderer } = require('electron');
const { exposeTerminalBridge } = require('../nero_modules/terminal/src/transport/electron-preload');

/**
 * Frameless title-bar controls.
 * @typedef {object} WindowAPI
 * @property {function(boolean): Promise<boolean>} setTitleBarTheme
 *   Recolour the native window-control overlay for the dark (`true`) or light theme.
 */

/**
 * Saved-session (PuTTY "Saved Sessions") persistence.
 * @typedef {object} ProfilesAPI
 * @property {function(): Promise<Array<SessionProfile>>} list   List all saved profiles.
 * @property {function(SessionProfile): Promise<Array<SessionProfile>>} save  Upsert by `name`; returns the new list.
 * @property {function(string): Promise<Array<SessionProfile>>} delete  Remove by `name`; returns the new list.
 */

/**
 * Session configuration & lifecycle exposed to the renderer.
 * @typedef {object} SessionAPI
 * @property {function(): Promise<Array<ShellDescriptor>>} detectShells  Local shells found on this machine.
 * @property {function(): Promise<?string>} browseDir   Pick a start directory (dialog); `null` if cancelled.
 * @property {function(): Promise<?string>} browseKey   Pick a private-key file (dialog); `null` if cancelled.
 * @property {function(SessionOptions): Promise<SessionResult>} open  Open a session and wire it to the terminal.
 * @property {function(): Promise<boolean>} close       Dispose the active session.
 * @property {ProfilesAPI} profiles                     Saved-session persistence.
 * @property {function(function(string): void): void} onOpenProfile
 *   Register a callback invoked with a saved-session name when the app is asked
 *   to open one (Windows jump-list entry or `--open-profile` launch argument).
 *   An early request that arrives before the renderer listens is buffered and
 *   delivered as soon as the callback is registered.
 */

// window.terminalAPI — PTY data flow (input/data/resize) for the terminal view.
exposeTerminalBridge({ contextBridge, ipcRenderer });

// "open this saved session" requests from main (jump list / --open-profile).
// Attached at preload time so an early request is captured; it is buffered until
// the renderer registers its callback via sessionAPI.onOpenProfile().
let pendingProfile = null;
let openProfileCb = null;
ipcRenderer.on('app:open-profile', (_e, name) => {
  if (openProfileCb) openProfileCb(name);
  else pendingProfile = name;
});

/** @type {WindowAPI} */
contextBridge.exposeInMainWorld('windowAPI', {
  setTitleBarTheme: (dark) => ipcRenderer.invoke('window:titlebar', dark),
});

/** @type {SessionAPI} */
contextBridge.exposeInMainWorld('sessionAPI', {
  detectShells: () => ipcRenderer.invoke('session:detectShells'),
  browseDir: () => ipcRenderer.invoke('session:browseDir'),
  browseKey: () => ipcRenderer.invoke('session:browseKey'),
  open: (opts) => ipcRenderer.invoke('session:open', opts),
  close: () => ipcRenderer.invoke('session:close'),
  profiles: {
    list: () => ipcRenderer.invoke('profiles:list'),
    save: (profile) => ipcRenderer.invoke('profiles:save', profile),
    delete: (name) => ipcRenderer.invoke('profiles:delete', name),
  },
  onOpenProfile: (cb) => {
    openProfileCb = cb;
    if (pendingProfile != null) { const n = pendingProfile; pendingProfile = null; cb(n); }
  },
});
