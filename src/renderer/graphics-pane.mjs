/**
 * @file GraphicsPane — renderer-side controller for the internal GUI display.
 * Owns the `#gui-pane` (toolbar + `<canvas>`), drives a GUI session via
 * `window.guiAPI`, paints incoming JPEG frames (letterboxed, aspect-preserved),
 * confirms each painted frame (backpressure), routes input via {@link InputRouter},
 * and keeps the remote render size in step with the canvas. Text rendering stays
 * in xterm.js; this pane is image-only.
 * @module renderer/graphics-pane
 */

import { InputRouter } from './input-router.mjs';

const $ = (id) => document.getElementById(id);

/**
 * @param {object} deps
 * @param {import('../nero_modules/i18n/src/i18n.mjs').I18n} deps.i18n
 * @param {function(): void} deps.onShow  switch the UI to the GUI pane.
 * @param {function(): void} deps.onHide  switch back to the terminal.
 * @returns {{ openBrowser: function(object): Promise<{ok:boolean,error?:string}>, close: function(): void, isActive: function(): boolean }}
 */
export function createGuiController({ i18n, onShow, onHide }) {
  const gui = window.guiAPI;
  let active = false;
  let offs = [];
  let router = null;
  let resizeObs = null;
  let resizeTimer = null;
  let bitmap = null;
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

  function draw() {
    const c = canvas(); if (!c || !bitmap) return;
    const ctx = c.getContext('2d');
    const scale = Math.min(c.width / bitmap.width, c.height / bitmap.height);
    const dw = bitmap.width * scale, dh = bitmap.height * scale;
    const ox = (c.width - dw) / 2, oy = (c.height - dh) / 2;
    fit = { scale, offsetX: ox, offsetY: oy, w: bitmap.width, h: bitmap.height };
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(bitmap, ox, oy, dw, dh);
  }

  async function onFrame(f) {
    if (!active || !f || !f.data) return;
    try {
      const blob = new Blob([f.data], { type: 'image/jpeg' });
      const bmp = await createImageBitmap(blob);
      if (bitmap && bitmap.close) bitmap.close();
      bitmap = bmp;
      draw();
    } catch (_) { /* skip a bad frame */ }
    gui.ackFrame(f.seq);   // confirm paint -> release next frame
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
    if (message === 'no-ssh-session') return i18n.t('gui.err_no_ssh');
    return i18n.t('gui.state_error') + (message ? `: ${message}` : '');
  }

  /** client px -> remote px, accounting for canvas CSS scaling and letterboxing. */
  function mapCoords(clientX, clientY) {
    const c = canvas(); if (!c || !bitmap) return null;
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
      if (active && c) gui.resize(c.width, c.height, window.devicePixelRatio || 1);
      draw();
    }, 200);
  }

  function setCapture(on) {
    if (router) { router.setCapture(on); setCaptureIndicator(); }
    if (on) canvas().focus();
  }

  /**
   * @param {object} o  { url, quality }
   * @returns {Promise<{ok:boolean, error?:string}>}
   */
  async function openBrowser(o) {
    if (active) close();
    onShow();
    active = true;
    fitCanvasToWrap();
    setOverlay(i18n.t('gui.state_starting'));

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
      mode: 'chromium', url: o.url || 'about:blank',
      width: c.width, height: c.height, quality: Number(o.quality) || 60,
    });
    if (!r || !r.ok) {
      const msg = errText(r && r.error);
      close();
      return { ok: false, error: msg };
    }
    return { ok: true };
  }

  function close() {
    if (!active) return;
    active = false;
    try { gui.close(); } catch (_) {}
    for (const off of offs.splice(0)) { try { off(); } catch (_) {} }
    if (router) { router.detach(); router = null; }
    if (resizeObs) { try { resizeObs.disconnect(); } catch (_) {} resizeObs = null; }
    if (resizeTimer) { clearTimeout(resizeTimer); resizeTimer = null; }
    if (bitmap && bitmap.close) { try { bitmap.close(); } catch (_) {} }
    bitmap = null;
    setOverlay('');
    onHide();
  }

  return { openBrowser, close, isActive: () => active };
}
