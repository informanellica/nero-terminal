/**
 * @file GraphicsPane — renderer-side controller for the internal GUI display.
 * Owns the `#gui-pane` (toolbar + `<canvas>`), drives a GUI session via
 * `window.guiAPI`, paints incoming frames, confirms each painted frame
 * (backpressure), routes input via {@link InputRouter}, and keeps the remote
 * render size in step with the canvas (chromium mode only — the X11 virtual
 * display has a fixed preset size). Text rendering stays in xterm.js; this
 * pane is image-only.
 *
 * Frames arrive in two formats, painted into a remote-sized backing canvas
 * that is then drawn letterboxed onto the visible canvas:
 *   'jpeg'        full frame (chromium / CDP screencast)
 *   'rgba-rects'  partial RGBA rectangles (X11 / VNC deltas)
 * @module renderer/graphics-pane
 */

import { InputRouter } from './input-router.mjs';

const $ = (id) => document.getElementById(id);

/**
 * @param {object} deps
 * @param {import('../nero_modules/i18n/src/i18n.mjs').I18n} deps.i18n
 * @param {function(): void} deps.onShow  switch the UI to the GUI pane.
 * @param {function(): void} deps.onHide  switch back to the terminal.
 * @returns {{ openBrowser: function(object): Promise<{ok:boolean,error?:string}>,
 *             openX11: function(object): Promise<{ok:boolean,error?:string}>,
 *             close: function(): void, isActive: function(): boolean }}
 */
export function createGuiController({ i18n, onShow, onHide }) {
  const gui = window.guiAPI;
  let active = false;
  let mode = 'chromium';
  let offs = [];
  let router = null;
  let resizeObs = null;
  let resizeTimer = null;
  let backing = null;       // OffscreenCanvas at the remote framebuffer size
  let backingCtx = null;
  let fit = { scale: 1, offsetX: 0, offsetY: 0, w: 1, h: 1 };

  const canvas = () => /** @type {HTMLCanvasElement} */ ($('gui-canvas'));
  const wrap = () => $('gui-canvas-wrap');

  function setOverlay(text) {
    const ov = $('gui-overlay');
    if (!ov) return;
    ov.textContent = text || '';
    ov.classList.toggle('show', !!text);
  }

  function setCaptureIndicator() {
    const ind = $('gui-capture-ind');
    if (!ind || !router) return;
    const on = router.capturing;
    ind.textContent = i18n.t(on ? 'gui.capture_on' : 'gui.capture_off');
    ind.classList.toggle('off', !on);
  }

  function fitCanvasToWrap() {
    const c = canvas(); const w = wrap();
    if (!c || !w) return;
    const cw = Math.max(1, w.clientWidth);
    const ch = Math.max(1, w.clientHeight);
    if (c.width !== cw || c.height !== ch) { c.width = cw; c.height = ch; }
  }

  function ensureBacking(w, h) {
    if (!backing || backing.width !== w || backing.height !== h) {
      backing = new OffscreenCanvas(w, h);
      backingCtx = backing.getContext('2d');
    }
  }

  function draw() {
    const c = canvas(); if (!c || !backing) return;
    const ctx = c.getContext('2d');
    const scale = Math.min(c.width / backing.width, c.height / backing.height);
    const dw = backing.width * scale, dh = backing.height * scale;
    const ox = (c.width - dw) / 2, oy = (c.height - dh) / 2;
    fit = { scale, offsetX: ox, offsetY: oy, w: backing.width, h: backing.height };
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(backing, ox, oy, dw, dh);
  }

  async function onFrame(f) {
    if (!active || !f) return;
    try {
      if (f.format === 'rgba-rects' && Array.isArray(f.rects)) {
        ensureBacking(f.w, f.h);
        for (const r of f.rects) {
          backingCtx.putImageData(new ImageData(new Uint8ClampedArray(r.data.buffer || r.data, r.data.byteOffset || 0, r.w * r.h * 4), r.w, r.h), r.x, r.y);
        }
      } else if (f.data) {
        const bmp = await createImageBitmap(new Blob([f.data], { type: 'image/jpeg' }));
        ensureBacking(bmp.width, bmp.height);
        backingCtx.drawImage(bmp, 0, 0);
        if (bmp.close) bmp.close();
      }
      draw();
    } catch (_) { /* skip a bad frame */ }
    gui.ackFrame(f.seq);   // confirm paint -> release next frame/delta
  }

  function onState(s) {
    if (!s) return;
    if (s.state === 'running') setOverlay('');
    else if (s.state === 'starting') setOverlay(i18n.t('gui.state_starting'));
    else if (s.state === 'error') setOverlay(errText(s.message));
    else if (s.state === 'closed') close();
  }

  function onStats(s) {
    const el = $('gui-stats');
    if (el && s) el.textContent = `${fit.w}×${fit.h}  ${s.fps}fps  ${s.kbps}KB/s`;
  }

  function errText(message) {
    if (message === 'browser-missing') return i18n.t('gui.err_browser_missing');
    if (message === 'x11-missing') return i18n.t('gui.err_x11_missing');
    if (message === 'no-ssh-session') return i18n.t('gui.err_no_ssh');
    return i18n.t('gui.state_error') + (message ? `: ${message}` : '');
  }

  /** client px -> remote px, accounting for canvas CSS scaling and letterboxing. */
  function mapCoords(clientX, clientY) {
    const c = canvas(); if (!c || !backing) return null;
    const rect = c.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    const cx = (clientX - rect.left) * (c.width / rect.width);
    const cy = (clientY - rect.top) * (c.height / rect.height);
    const x = (cx - fit.offsetX) / fit.scale;
    const y = (cy - fit.offsetY) / fit.scale;
    return { x: Math.max(0, Math.min(fit.w, x)), y: Math.max(0, Math.min(fit.h, y)) };
  }

  function scheduleResize() {
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      fitCanvasToWrap();
      const c = canvas();
      // X11 mode has a fixed virtual-display size: rescale locally only.
      if (active && c && mode === 'chromium') gui.resize(c.width, c.height, window.devicePixelRatio || 1);
      draw();
    }, 200);
  }

  function setCapture(on) {
    if (router) { router.setCapture(on); setCaptureIndicator(); }
    if (on) canvas().focus();
  }

  /**
   * Open a GUI session and switch to the pane.
   * @param {object} o  { mode, url, quality, width, height, command, encodings }
   * @returns {Promise<{ok:boolean, error?:string}>}
   */
  async function open(o) {
    if (active) close();
    mode = o.mode || 'chromium';
    onShow();
    active = true;
    fitCanvasToWrap();
    setOverlay(i18n.t('gui.state_starting'));

    // URL bar only makes sense for the browser backend.
    const urlRow = mode === 'chromium' ? '' : 'none';
    if ($('gui-url')) $('gui-url').style.display = urlRow;
    if ($('gui-go')) $('gui-go').style.display = urlRow;

    offs.push(gui.onFrame(onFrame));
    offs.push(gui.onState(onState));
    offs.push(gui.onStats(onStats));

    const c = canvas();
    router = new InputRouter({
      canvas: c, send: (m) => gui.input(m), mapCoords, onEscape: () => setCapture(false),
    });
    router.attach();
    // Clicking the canvas grabs keyboard capture; Ctrl+] releases it.
    c.addEventListener('pointerdown', () => setCapture(true));
    setCapture(false);

    resizeObs = new ResizeObserver(scheduleResize);
    resizeObs.observe(wrap());

    const r = await gui.open({
      mode, url: o.url || 'about:blank',
      width: o.width || c.width, height: o.height || c.height,
      quality: Number(o.quality) || 60,
      command: o.command, encodings: o.encodings,
    });
    if (!r || !r.ok) {
      const msg = errText(r && r.error);
      close();
      return { ok: false, error: msg };
    }
    return { ok: true };
  }

  /** @param {object} o  { url, quality } */
  function openBrowser(o) { return open({ mode: 'chromium', url: o.url, quality: o.quality }); }

  /** @param {object} o  { command, width, height } */
  function openX11(o) { return open({ mode: 'x11', command: o.command, width: o.width, height: o.height }); }

  function close() {
    if (!active) return;
    active = false;
    try { gui.close(); } catch (_) {}
    for (const off of offs.splice(0)) { try { off(); } catch (_) {} }
    if (router) { router.detach(); router = null; }
    if (resizeObs) { try { resizeObs.disconnect(); } catch (_) {} resizeObs = null; }
    if (resizeTimer) { clearTimeout(resizeTimer); resizeTimer = null; }
    backing = null; backingCtx = null;
    setOverlay('');
    onHide();
  }

  return { openBrowser, openX11, close, isActive: () => active };
}
