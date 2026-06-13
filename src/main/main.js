'use strict';

/**
 * @file Electron **main process** entry point for nero-terminal.
 *
 * Responsibilities:
 * - create the application window — a frameless, Tera&nbsp;Term-style window whose
 *   native minimise/maximise/close controls are overlaid at the top-right, leaving
 *   room in the custom title bar (to their left) for the in-app Settings button;
 * - register the session manager's IPC handlers (see {@link module:main/session-manager});
 * - keep the native title-bar overlay colours in step with the renderer's light/dark theme;
 * - drive the standard app lifecycle through nero-electron-lib's `runApp`.
 *
 * The terminal itself (PTY / SSH backends and the xterm view) lives in the
 * shared libraries under `nero_modules/`; this file is only the app shell.
 *
 * @module main/main
 */

const path = require('path');
const { app, ipcMain, dialog, Menu } = require('electron');
const { createWindow, runApp, loadBuildInfo, formatTitle } = require('../nero_modules/electron');
const { createSessionManager, buildJumpList } = require('./session-manager');
const { registerUpdater } = require('./updater');
const { createGuiManager } = require('./gui-manager');

/**
 * The single application window, or `null` before creation / after it closes.
 * @type {Electron.BrowserWindow|null}
 */
let win;

/**
 * The session manager bound to this window. Registered once at startup.
 * @see module:main/session-manager.createSessionManager
 */
const sessions = createSessionManager({
  app, ipcMain, dialog,
  getWindow: () => win,
  onProfilesChanged: () => setupJumpList(),
  onSessionClose: () => { if (gui) gui.close(); },
});
sessions.register();

// Internal GUI display (Chromium/CDP over the active SSH connection; see ./gui-manager).
const gui = createGuiManager({
  ipcMain,
  getWindow: () => win,
  getActiveHost: () => sessions.getActiveHost(),
});
gui.register();

// Update checker (check-and-notify only; see ./updater).
registerUpdater({ ipcMain, app });

/**
 * IPC `window:titlebar` — recolour the native window-control overlay to match
 * the renderer's light/dark theme. Invoked from the renderer via
 * `window.windowAPI.setTitleBarTheme(dark)`.
 *
 * @function
 * @param {Electron.IpcMainInvokeEvent} _e
 * @param {boolean} dark  `true` for the dark palette, `false` for light.
 * @returns {boolean} `true` if the overlay was updated, `false` if unavailable.
 */
ipcMain.handle('window:titlebar', (_e, dark) => {
  if (!win || typeof win.setTitleBarOverlay !== 'function') return false;
  try {
    win.setTitleBarOverlay({ color: dark ? '#1e1e1e' : '#f8f9fa', symbolColor: dark ? '#dddddd' : '#222222', height: 32 });
    return true;
  } catch (_) { return false; }
});

/**
 * Create the application window and wire its lifecycle.
 *
 * Removes the default menu, stamps the build info into the title
 * (`nero-terminal vX.Y.Z [DEBUG] (commit)`), configures the frameless title bar
 * with a native-controls overlay, loads the renderer, and disposes the active
 * session when the window closes. Called by `runApp` on ready and on macOS
 * re-activation.
 *
 * @returns {Electron.BrowserWindow} the newly created window.
 */
function makeWindow() {
  Menu.setApplicationMenu(null);
  const info = loadBuildInfo(path.join(__dirname, '..'));

  win = createWindow({
    width: 980,
    height: 660,
    minWidth: 720,
    minHeight: 480,
    backgroundColor: '#000000',
    title: formatTitle('nero-terminal', info),
    icon: path.join(__dirname, '..', 'assets', 'icon.ico'),
    openDevTools: info.isDebug,
    // Frameless title bar with native min/max/close overlaid top-right, leaving
    // room in our title bar (to their left) for a Settings button (Tera Term style).
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#1e1e1e', symbolColor: '#dddddd', height: 32 },
    webPreferences: {
      sandbox: false, // preload requires the terminal-lib preload helper
      backgroundThrottling: false, // keep the terminal rendering when backgrounded
      preload: path.join(__dirname, 'preload.js'),
    },
    loadFile: path.join(__dirname, '..', 'renderer', 'index.html'),
  });

  win.on('closed', () => { sessions.closeSession(); win = null; });

  // Open a saved session requested on the command line (jump list / --open-profile).
  win.webContents.on('did-finish-load', () => {
    const name = parseProfileArg(process.argv);
    if (name) sendOpenProfile(name);
  });
  setupJumpList();
  return win;
}

/**
 * Extract a saved-session name from a `--open-profile=<name>` launch argument.
 * @param {string[]} argv  a process argument vector.
 * @returns {string|null}  the profile name, or `null` if not present.
 */
function parseProfileArg(argv) {
  const a = (argv || []).find((x) => typeof x === 'string' && x.startsWith('--open-profile='));
  return a ? a.slice('--open-profile='.length) : null;
}

/**
 * Ask the renderer to open a saved session by name.
 * @param {string} name  the saved session's name.
 */
function sendOpenProfile(name) {
  if (win && win.webContents) win.webContents.send('app:open-profile', name);
}

/**
 * Publish the saved sessions as a Windows taskbar jump list (no-op on other
 * platforms), so right-clicking the taskbar icon can launch a saved session.
 */
function setupJumpList() {
  if (process.platform !== 'win32' || typeof app.setJumpList !== 'function') return;
  try {
    const icon = path.join(__dirname, '..', 'assets', 'icon.ico');
    app.setJumpList(buildJumpList(process.execPath, sessions.loadProfiles(), icon));
  } catch (_) { /* jump list is best-effort */ }
}

// Single-instance lock: a jump-list click while the app is running reuses the
// existing window (via `second-instance`) instead of spawning a new process.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
    const name = parseProfileArg(argv);
    if (name) sendOpenProfile(name);
  });
  runApp(makeWindow);
}
