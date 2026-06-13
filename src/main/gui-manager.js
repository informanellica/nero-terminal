'use strict';

/**
 * @file GUI session manager (main process) — registers the `gui:*` IPC surface
 * for the "internal GUI display" feature and bridges a {@link GuiSession} to the
 * renderer's GraphicsPane. The GUI session reuses the active SSH session's ssh2
 * connection (no new SSH connection, no new exposed port); if there is no live
 * SSH session, `gui:open` reports `no-ssh-session`.
 *
 * @module main/gui-manager
 */

const { GuiSession } = require('../nero_modules/terminal/src/backend/gui-session');

/**
 * @param {object} deps
 * @param {Electron.IpcMain} deps.ipcMain
 * @param {function(): (Electron.BrowserWindow|null)} deps.getWindow
 * @param {function(): object} deps.getActiveHost  returns the active backend host (SshHost/PtyHost) or null.
 * @returns {{register: function(): void, close: function(): void}}
 */
function createGuiManager({ ipcMain, getWindow, getActiveHost }) {
  /** @type {?GuiSession} */
  let session = null;

  function send(channel, payload) {
    const win = getWindow();
    if (win && win.webContents && !win.webContents.isDestroyed()) win.webContents.send(channel, payload);
  }

  function close() {
    if (session) { try { session.close(); } catch (_) {} session = null; }
  }

  async function open(opts) {
    const host = getActiveHost();
    if (!host || !host.isSsh || !host.connection) return { ok: false, error: 'no-ssh-session' };
    close();
    session = new GuiSession({
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
    const current = session;
    session.on('frame', (f) => { if (session === current) send('gui:frame', f); });
    session.on('state', (s) => { if (session === current) send('gui:state', s); });
    session.on('stats', (s) => { if (session === current) send('gui:stats', s); });
    try {
      await session.open();
      return { ok: true };
    } catch (e) {
      // state:'error' was already emitted by GuiSession; surface the reason too.
      if (session === current) { try { session.close(); } catch (_) {} session = null; }
      return { ok: false, error: (e && e.message) || 'gui-open-failed' };
    }
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

  return { register, close };
}

module.exports = { createGuiManager };
