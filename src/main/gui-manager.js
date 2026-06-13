'use strict';

/**
 * @file GUI session manager (main process). Bridges one {@link GuiSession} to a
 * renderer surface:
 *
 * - the MAIN window's GraphicsPane (settings "GUI" panel: remote browser / X11
 *   desktop), or
 * - SEAMLESS per-window popups for "internal X11 forwarding": an SSH session
 *   opened with x11 mode = internal starts a remote Xvfb + x11vnc desktop (no
 *   external X server), tracks each top-level X window, and shows EACH window in
 *   its own popup (cropped from the shared framebuffer). The shell's DISPLAY is
 *   preset at shell start (nothing is typed). A window appears only when an app
 *   actually maps it; closing the app closes its popup.
 *
 * Only one GUI session exists at a time.
 *
 * @module main/gui-manager
 */

const path = require('path');
const { BrowserWindow, dialog } = require('electron');
const { GuiSession } = require('../nero_modules/terminal/src/backend/gui-session');

function createGuiManager({ ipcMain, getWindow, getActiveHost }) {
  /** @type {?GuiSession} */
  let session = null;
  /** @type {?Electron.WebContents} */  // main-window path target (graphics-pane)
  let targetWC = null;
  /** @type {Map<string,{popup:Electron.BrowserWindow, geom:object}>} */  // seamless popups
  let winPopups = new Map();

  function sendMain(channel, payload) {
    if (targetWC && !targetWC.isDestroyed()) targetWC.send(channel, payload);
  }

  function closeSeamless() {
    for (const entry of winPopups.values()) {
      entry.closing = true;   // our teardown — don't try to close the (gone) remote window
      try { if (entry.popup && !entry.popup.isDestroyed()) entry.popup.close(); } catch (_) {}
    }
    winPopups.clear();
  }

  function close() {
    if (session) { try { session.close(); } catch (_) {} session = null; }
    targetWC = null;
    closeSeamless();
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
      seamless: opts && opts.seamless,
    });
  }

  /** GUI session shown in the MAIN window's GraphicsPane (settings panel). */
  async function open(opts) {
    const host = getActiveHost();
    if (!host || !host.isSsh || !host.connection) return { ok: false, error: 'no-ssh-session' };
    close();
    const win = getWindow();
    targetWC = win && win.webContents;
    session = makeSession(host, opts);
    const current = session;
    session.on('frame', (f) => { if (session === current) sendMain('gui:frame', f); });
    session.on('state', (s) => { if (session === current) sendMain('gui:state', s); });
    session.on('stats', (s) => { if (session === current) sendMain('gui:stats', s); });
    try { await session.open(); return { ok: true }; }
    catch (e) {
      if (session === current) { try { session.close(); } catch (_) {} session = null; targetWC = null; }
      return { ok: false, error: (e && e.message) || 'gui-open-failed' };
    }
  }

  /**
   * Internal X11: seamless per-window popups. Starts a remote Xvfb desktop and
   * shows each top-level window in its own cropped popup. Fire-and-forget.
   * @param {object} sshHost  the active SshHost (its shell gets DISPLAY=:N at start).
   */
  function openInternalX11(sshHost) {
    if (!sshHost) return;
    close();
    const parent = getWindow();
    let started = false;
    let displaySet = false;
    let errored = false;

    const showError = (msg) => {
      try { sshHost.startShell(); } catch (_) {}     // ensure the terminal still works
      if (errored) return; errored = true;
      // Tear down the GUI session too — VncBackend.close() stops the remote
      // Xvfb/x11vnc (and runs the PID/port cleanup); closing only the popups
      // would leak those remote processes on a startup failure.
      close();
      const detail = msg === 'x11-missing'
        ? 'The remote host needs Xvfb, x11vnc and xdotool (openbox recommended) for the in-app X11 display.\n'
          + 'Install them, e.g.:\n  Debian/Ubuntu:  sudo apt install xvfb x11vnc xdotool openbox\n  Alpine:  apk add xvfb x11vnc xdotool openbox\n\n'
          + 'リモートに Xvfb / x11vnc / xdotool（openbox 推奨）が必要です。上記でインストールしてください。'
        : 'Internal X11 display failed: ' + msg;
      try { dialog.showMessageBox(parent || undefined, { type: 'warning', title: 'nero-terminal — X11', message: 'In-app X11 display unavailable', detail }); } catch (_) {}
    };

    // Ids the user just closed: suppress re-creating their popup while the app
    // exits (otherwise the tracker re-detects the still-closing window and the
    // popup "respawns").
    const suppressed = new Set();

    const reconcile = (list) => {
      const seen = new Set();
      for (const w of (list || [])) {
        seen.add(w.id);
        if (suppressed.has(w.id)) continue;
        const entry = winPopups.get(w.id);
        if (!entry) {
          const popup = new BrowserWindow({
            width: Math.max(80, w.w), height: Math.max(60, w.h),
            parent: parent || undefined, show: true, backgroundColor: '#000',
            title: w.title || 'X11',
            webPreferences: { sandbox: false, contextIsolation: true, preload: path.join(__dirname, 'preload.js') },
          });
          popup.removeMenu && popup.removeMenu();
          popup.on('page-title-updated', (ev) => ev.preventDefault());   // keep the X window title
          const e = { popup, geom: w, closing: false };
          winPopups.set(w.id, e);
          popup.on('closed', () => {
            winPopups.delete(w.id);
            // User closed the window -> close the remote X window so the app exits
            // (and its shell command finishes); suppress respawn while it closes.
            if (!e.closing && session) {
              suppressed.add(w.id);
              setTimeout(() => suppressed.delete(w.id), 6000);
              try { session.closeWindow(w.id); } catch (_) {}
            }
          });
          popup.loadFile(path.join(__dirname, '..', 'renderer', 'gui-popup.html'));
          popup.webContents.once('did-finish-load', () => {
            if (popup.isDestroyed()) return;
            // Set the title AFTER load so the page's <title> doesn't override it.
            try { popup.setTitle(e.geom.title || 'X11'); } catch (_) {}
            popup.webContents.send('gui:geom', e.geom);
            if (session) session.requestFull();   // so the new popup gets a full image
          });
        } else if (geomChanged(entry.geom, w)) {
          entry.geom = w;
          if (!entry.popup.isDestroyed()) {
            try { entry.popup.setContentSize(Math.max(80, w.w), Math.max(60, w.h)); } catch (_) {}
            if (w.title) { try { entry.popup.setTitle(w.title); } catch (_) {} }
            entry.popup.webContents.send('gui:geom', w);
          }
        }
      }
      for (const [id, entry] of [...winPopups]) {
        if (!seen.has(id)) {
          entry.closing = true;   // window vanished on its own — don't re-close it remotely
          try { if (!entry.popup.isDestroyed()) entry.popup.close(); } catch (_) {}
          winPopups.delete(id);
        }
      }
    };

    const begin = () => {
      if (started || !sshHost.ready || !sshHost.connection) return;
      started = true;
      session = makeSession(sshHost, { mode: 'x11', seamless: true, width: 1280, height: 720 });
      const current = session;
      session.on('state', (s) => {
        if (session !== current || !s) return;
        if (s.state === 'running' && s.display != null && !displaySet) {
          displaySet = true;
          try { sshHost.startShell({ DISPLAY: `:${s.display}` }); } catch (_) {}
        }
        if (s.state === 'error') showError(s.message);
        if (s.state === 'closed') closeSeamless();
      });
      session.on('frame', (f) => {
        if (session !== current) return;
        session.ackFrame(f.seq);   // ack centrally so the VNC stream keeps pumping
        for (const { popup } of winPopups.values()) {
          if (popup && !popup.isDestroyed()) popup.webContents.send('gui:frame', f);
        }
      });
      session.on('windows', (list) => { if (session === current) reconcile(list); });
      session.open().catch((e) => showError((e && e.message) || 'gui-open-failed'));
    };

    if (!sshHost.ready) sshHost.on('ready', () => begin());
    begin();
  }

  function register() {
    ipcMain.handle('gui:open', (_e, opts) => open(opts || {}));
    ipcMain.handle('gui:close', () => { close(); return true; });
    ipcMain.handle('gui:navigate', (_e, url) => { if (session) session.navigate(url); return true; });
    ipcMain.on('gui:input', (_e, msg) => { if (session) session.input(msg); });
    ipcMain.on('gui:resize', (_e, d) => { if (session && d) session.resize(d.width, d.height, d.dpr); });
    ipcMain.on('gui:frame-ack', (_e, d) => { if (session && d) session.ackFrame(d.seq); });
  }

  return { register, close, openInternalX11 };
}

function geomChanged(a, b) {
  return a.x !== b.x || a.y !== b.y || a.w !== b.w || a.h !== b.h || a.title !== b.title;
}

module.exports = { createGuiManager };
