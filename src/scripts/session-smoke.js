'use strict';

/**
 * @file End-to-end smoke for the session flow, in a real (hidden) Electron window.
 *
 * Drives the actual renderer over IPC: opens a **local** shell and asserts the
 * spawned PTY streams output back via `terminalAPI`, then opens an **SSH**
 * session to an unreachable host and asserts the PuTTY-style interactive login
 * (`login as:` → password → `Connecting…`) reaches the terminal. Exercises
 * {@link module:main/session-manager} end to end without a real SSH server.
 *
 * Run: `env -u ELECTRON_RUN_AS_NODE electron scripts/session-smoke.js`
 * (exit 0 = pass, 1 = fail).
 *
 * @module scripts/session-smoke
 */

const path = require('path');
const { app, ipcMain, dialog, BrowserWindow } = require('electron');
const { createSessionManager } = require('../main/session-manager');

let win;
const sessions = createSessionManager({ app, ipcMain, dialog, getWindow: () => win });
sessions.register();

function finish(ok, why) {
  console.log(ok ? `SESSION SMOKE PASS: ${why}` : `SESSION SMOKE FAIL: ${why}`);
  app.exit(ok ? 0 : 1);
}

app.whenReady().then(() => {
  win = new BrowserWindow({
    width: 900, height: 600, show: false,
    webPreferences: {
      contextIsolation: true, nodeIntegration: false, sandbox: false,
      preload: path.join(__dirname, '..', 'main', 'preload.js'),
    },
  });
  win.webContents.on('console-message', (_e, _l, m) => console.log('[renderer]', m));
  win.webContents.on('preload-error', (_e, p, err) => console.log('[preload-error]', err && err.message));

  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.webContents.once('did-finish-load', async () => {
    try {
      const r = await win.webContents.executeJavaScript(`(async () => {
        const wait = (ms) => new Promise(r => setTimeout(r, ms));
        const firstData = (timeout) => new Promise(res => {
          let n = 0; const off = window.terminalAPI.onData(d => { n += d.length; if (n > 0) { off && off(); res(n); } });
          setTimeout(() => res(n), timeout);
        });
        await wait(400);

        // --- Local shell ---
        document.getElementById('ctype-local').checked = true;
        document.getElementById('ctype-local').dispatchEvent(new Event('change'));
        let p = firstData(8000);
        document.getElementById('btn-open').click();
        const localBytes = await p;
        document.getElementById('btn-back').click();
        await wait(500);

        // --- SSH (no username): expect PuTTY-style interactive login in the terminal ---
        document.getElementById('ctype-ssh').checked = true;
        document.getElementById('ctype-ssh').dispatchEvent(new Event('change'));
        document.getElementById('host').value = '127.0.0.1';
        document.getElementById('port').value = '1';
        let acc = '';
        const offSsh = window.terminalAPI.onData(d => { acc += d; });
        const until = (re, ms) => new Promise(res => {
          const t0 = Date.now();
          (function poll(){ if (re.test(acc)) return res(true); if (Date.now()-t0>ms) return res(false); setTimeout(poll, 50); })();
        });
        document.getElementById('btn-open').click();
        const sawLogin = await until(/login as:/i, 6000);
        window.terminalAPI.sendInput('tester\\r');               // type username
        const sawPassword = await until(/password:/i, 6000);
        window.terminalAPI.sendInput('secret\\r');               // type password
        const sawConnecting = await until(/Connecting to 127\\.0\\.0\\.1:1/, 6000);
        offSsh();
        return { localBytes, sawLogin, sawPassword, sawConnecting };
      })()`);
      finish(r.localBytes > 0 && r.sawLogin && r.sawPassword && r.sawConnecting,
        `local PTY ${r.localBytes} bytes; SSH interactive login: login-as=${r.sawLogin} password=${r.sawPassword} connecting=${r.sawConnecting}`);
    } catch (e) {
      finish(false, 'threw: ' + (e && e.message));
    }
  });
  setTimeout(() => finish(false, 'timed out'), 24000);
});

app.on('window-all-closed', () => app.quit());
