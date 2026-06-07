'use strict';

/**
 * @file Update checker — **check-and-notify only**. It asks the GitHub Releases
 * API whether a newer version exists and, if so, lets the renderer offer a
 * "Download" action that opens the official releases page in the user's browser.
 *
 * The app intentionally NEVER downloads or executes an installer itself, which
 * removes the "URL-substitution → auto-run" attack path (cf. the Notepad++-class
 * supply-chain incidents). Defence in depth:
 *
 *  1. HTTPS only, validated against the OS trust store (Electron `net`).
 *  2. Source pinning — the API endpoint and the download page are hard-coded to
 *     `informanellica/nero-terminal`; a redirect that leaves the GitHub hosts is
 *     rejected, and the "Download" action opens a FIXED constant URL (never a URL
 *     taken from the API response).
 *  3. The downloaded installer is code-signed; the user verifies the publisher at
 *     install time (and Windows SmartScreen/UAC shows the signer). Because the
 *     signing certificate lives only on the local build machine, an attacker who
 *     swapped the binary cannot reproduce a build carrying our thumbprint.
 *
 * @module main/updater
 */

const { net, shell } = require('electron');

const OWNER = 'informanellica';
const REPO = 'nero-terminal';
const API_LATEST = `https://api.github.com/repos/${OWNER}/${REPO}/releases/latest`;
/** The ONLY URL the "Download" action ever opens. */
const RELEASES_PAGE = `https://github.com/${OWNER}/${REPO}/releases/latest`;
/** Hosts a release-related redirect is permitted to stay within. */
const ALLOWED_HOSTS = new Set(['api.github.com', 'github.com', 'objects.githubusercontent.com']);

/**
 * Parse a `vX.Y.Z[-pre]` tag into comparable numeric parts (pre-release suffix
 * ignored). Returns `null` if it does not look like a version.
 * @param {string} v
 * @returns {?number[]}
 */
function parseVersion(v) {
  const m = String(v || '').trim().replace(/^v/i, '').match(/^(\d+)\.(\d+)\.(\d+)/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/**
 * @param {number[]} a @param {number[]} b
 * @returns {number} >0 if a>b, <0 if a<b, 0 if equal.
 */
function compareVersions(a, b) {
  for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] - b[i]; }
  return 0;
}

/**
 * Fetch the latest release tag from GitHub and compare it to the running build.
 * Never throws — failures resolve to `{ ok: false, error }`.
 * @param {string} currentVersion  the running app version (e.g. "0.2.1").
 * @returns {Promise<{ok:true, updateAvailable:boolean, current:string, latest:string, url:string}
 *   | {ok:false, error:string}>}
 */
function checkForUpdate(currentVersion) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };

    const cur = parseVersion(currentVersion);
    if (!cur) { done({ ok: false, error: 'bad-current-version' }); return; }

    let req;
    try {
      req = net.request({ method: 'GET', url: API_LATEST, redirect: 'manual' });
    } catch (e) {
      done({ ok: false, error: (e && e.message) || 'request-failed' }); return;
    }

    // Reject any redirect that would leave the trusted GitHub hosts.
    req.on('redirect', (_status, _method, redirectUrl) => {
      try {
        const host = new URL(redirectUrl).hostname;
        if (new URL(redirectUrl).protocol === 'https:' && ALLOWED_HOSTS.has(host)) {
          req.followRedirect();
        } else { req.abort(); done({ ok: false, error: 'untrusted-redirect' }); }
      } catch (_) { req.abort(); done({ ok: false, error: 'bad-redirect' }); }
    });

    req.setHeader('Accept', 'application/vnd.github+json');
    req.setHeader('User-Agent', `${REPO}-updater`);

    req.on('response', (res) => {
      if (res.statusCode !== 200) {
        res.on('data', () => {}); res.on('end', () => {});
        done({ ok: false, error: `http-${res.statusCode}` });
        return;
      }
      let body = '';
      res.on('data', (c) => { body += c.toString('utf8'); if (body.length > 1_000_000) req.abort(); });
      res.on('end', () => {
        let tag;
        try { tag = JSON.parse(body).tag_name; } catch (_) { done({ ok: false, error: 'bad-json' }); return; }
        const latest = parseVersion(tag);
        if (!latest) { done({ ok: false, error: 'bad-tag' }); return; }
        done({
          ok: true,
          updateAvailable: compareVersions(latest, cur) > 0,
          current: cur.join('.'),
          latest: latest.join('.'),
          url: RELEASES_PAGE,
        });
      });
    });

    req.on('error', (e) => done({ ok: false, error: (e && e.message) || 'network-error' }));
    // Hard timeout so a hung connection never leaves the check pending.
    setTimeout(() => { try { req.abort(); } catch (_) {} done({ ok: false, error: 'timeout' }); }, 10000);
    req.end();
  });
}

/**
 * Register the update IPC handlers.
 * @param {object} deps
 * @param {Electron.IpcMain} deps.ipcMain
 * @param {Electron.App} deps.app
 */
function registerUpdater({ ipcMain, app }) {
  ipcMain.handle('update:check', () => checkForUpdate(app.getVersion()));
  // Open ONLY the fixed, pinned releases page — never a URL from the API.
  ipcMain.handle('update:openDownload', async () => { await shell.openExternal(RELEASES_PAGE); return true; });
}

module.exports = { registerUpdater, checkForUpdate, parseVersion, compareVersions, RELEASES_PAGE };
