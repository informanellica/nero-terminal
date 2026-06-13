'use strict';

/**
 * @file GUI session manager (main process) — owns the `gui:*` IPC surface for
 * the internal GUI display and bridges a {@link GuiSession} to whichever
 * renderer surface should show it:
 *
 * - the MAIN window's GraphicsPane (settings "GUI" panel: remote browser / X11
 *   desktop), or
 * - a dedicated POPUP window for "internal X11 forwarding": when an SSH session
 *   is opened with x11 mode = internal, a virtual X display (Xvfb + x11vnc) is
 *   started on the remote, the shell's DISPLAY is pointed at it, and a popup
 *   renders it — so any X11 app the user runs in the terminal appears in-app
 *   with no external X server (VcXsrv).
 *
 * Frames are routed to the active target webContents; only one GUI session
 * exists at a time (opening another, or closing the SSH session, tears it down).
 *
 * @module main/gui-manager
 */

const path = require('path');
const { BrowserWindow } = require('electron');
const { GuiSession } = require('../nero_modules/terminal/src/backend/gui-session');

/**
 * @param {object} deps
 * @param {Electron.IpcMain} deps.ipcMain
 * @param {function(): (Electron.BrowserWindow|null)} deps.getWindow
 * @param {function(): object} deps.getActiveHost  returns the active backend host (SshHost/PtyHost) or null.
 * @returns {{ register: function(): void, close: function(): void, openInternalX11: function(object): Promise<object> }}
 */
function createGuiManager({ ipcMain, getWindow, getActiveHost }) {
  /** @type {?GuiSession} */
  let session = null;
  /** @type {?Electron.WebContents} */
  let targetWC = null;
  /** @type {?Electron.BrowserWindow} */
  let popup = null;

  function send(channel, payload) {
    const wc = targetWC;
    if (wc && !wc.isDestroyed()) wc.send(channel, payload);
  }

  function close() {
    if (session) { try { session.close(); } catch (_) {} session = null; }
    targetWC = null;
    if (popup && !popup.isDestroyed()) { try { popup.close(); } catch (_) {} }
    popup = null;
  }

  /** Open a GUI session shown in the MAIN window's GraphicsPane (settings panel). */
  async function open(opts) {
    const host = getActiveHost();
    if (!host || !host.isSsh || !host.connection) return { ok: false, error: 'no-ssh-session' };
    close();
    const win = getWindow();
    targetWC = win && win.webContents;
    session = makeSession(host, opts);
    const current = session;
    wire(current);
    try { await session.open(); return { ok: true }; }
    catch (e) {
      if (session === current) { try { session.close(); } catch (_) {} session = null; targetWC = null; }
      return { ok: false, error: (e && e.message) || 'gui-open-failed' };
    }
  }

  /**
   * Start the "internal X11" GUI for an SSH session: a remote Xvfb desktop shown
   * in a popup, with the shell's DISPLAY pointed at it. Called from main when an
   * SSH session is opened with x11 mode = internal.
   * @param {object} sshHost  the active SshHost (its shell receives `export DISPLAY=:N`).
   * @returns {Promise<{ok:boolean, error?:string}>}
   */
  function openInternalX11(sshHost) {
    if (!sshHost) return;
    close();
    const parent = getWindow();
    popup = new BrowserWindow({
      width: 1280, height: 760, parent: parent || undefined, show: true, backgroundColor: '#000',
      title: 'nero-terminal — X11',
      webPreferences: {
        sandbox: false, contextIsolation: true,
        preload: path.join(__dirname, 'preload.js'),
      },
    });
    popup.removeMenu && popup.removeMenu();
    const thisPopup = popup;
    popup.loadFile(path.join(__dirname, '..', 'renderer', 'gui-popup.html'));
    targetWC = popup.webContents;
    popup.on('closed', () => { if (popup === thisPopup) { popup = null; close(); } });

    // Start only once BOTH the SSH connection is authenticated (so exec/forwardOut
    // work and host.connection exists) AND the popup has loaded (so the first VNC
    // frame isn't lost — the request/ack backpressure would otherwise stall).
    let popupLoaded = false;
    let started = false;
    const begin = () => {
      if (started || !popupLoaded || !sshHost.ready || !sshHost.connection || popup !== thisPopup) return;
      started = true;
      session = makeSession(sshHost, { mode: 'x11', width: 1280, height: 720 });
      const current = session;
      let displaySet = false;
      session.on('frame', (f) => { if (session === current) send('gui:frame', f); });
      session.on('stats', (s) => { if (session === current) send('gui:stats', s); });
      session.on('state', (s) => {
        if (session !== current) return;
        send('gui:state', s);
        // Point the interactive shell's DISPLAY at the virtual display, once.
        if (s && s.state === 'running' && s.display != null && !displaySet) {
          displaySet = true;
          try { sshHost.write(`export DISPLAY=:${s.display}\n`); } catch (_) {}
        }
      });
      session.open().catch(() => { /* state:'error' already routed to the popup */ });
    };
    popup.webContents.once('did-finish-load', () => { popupLoaded = true; begin(); });
    if (!sshHost.ready) sshHost.on('ready', () => begin());
    begin();
  }

  function makeSession(host, opts) {
    return new GuiSession({
      connection: host.connection,
      backend: opts && opts.mode === 'x11' ? 'vnc' : 'chromium',
      width: (opts && opts.width) || 1280,
      height: (opts && opts.height) || 720,
      quality: opts && opts.quality,
      maxFps: opts && opts.maxFps,
      url: opts && opts.url,
      extraArgs: opts && opts.extraArgs,
      command: opts && opts.command,
      encodings: opts && opts.encodings,
    });
  }

  function wire(current) {
    session.on('frame', (f) => { if (session === current) send('gui:frame', f); });
    session.on('state', (s) => { if (session === current) send('gui:state', s); });
    session.on('stats', (s) => { if (session === current) send('gui:stats', s); });
  }

  function register() {
    ipcMain.handle('gui:open', (_e, opts) => open(opts || {}));
    ipcMain.handle('gui:close', () => { close(); return true; });
    ipcMain.handle('gui:navigate', (_e, url) => { if (session) session.navigate(url); return true; });
    // Fire-and-forget hot paths (no invoke round-trip).
    ipcMain.on('gui:input', (_e, msg) => { if (session) session.input(msg); });
    ipcMain.on('gui:resize', (_e, d) => { if (session && d) session.resize(d.width, d.height, d.dpr); });
    ipcMain.on('gui:frame-ack', (_e, d) => { if (session && d) session.ackFrame(d.seq); });
  }

  return { register, close, openInternalX11 };
}

module.exports = { createGuiManager };
