/**
 * @file Popup renderer for "internal X11 forwarding". A standalone window that
 * paints the remote virtual display (delivered as `gui:frame` events via
 * `window.guiAPI`) onto a canvas and forwards pointer/keyboard input back. The
 * GUI session is started by the main process before this window opens, so this
 * page only renders and routes input (it never calls guiAPI.open). Frame
 * formats handled: 'jpeg' (chromium) and 'rgba-rects' (X11/VNC deltas).
 * @module renderer/gui-popup
 */

import { InputRouter } from './input-router.mjs';

const $ = (id) => document.getElementById(id);
const gui = window.guiAPI;
const canvas = $('pop-canvas');
const wrap = $('pop-wrap');

let backing = null;
let backingCtx = null;
let fit = { scale: 1, offsetX: 0, offsetY: 0, w: 1, h: 1 };

function ensureBacking(w, h) {
  if (!backing || backing.width !== w || backing.height !== h) {
    backing = new OffscreenCanvas(w, h);
    backingCtx = backing.getContext('2d');
  }
}

function fitCanvas() {
  const cw = Math.max(1, wrap.clientWidth);
  const ch = Math.max(1, wrap.clientHeight);
  if (canvas.width !== cw || canvas.height !== ch) { canvas.width = cw; canvas.height = ch; }
}

function draw() {
  if (!backing) return;
  const ctx = canvas.getContext('2d');
  const scale = Math.min(canvas.width / backing.width, canvas.height / backing.height);
  const dw = backing.width * scale, dh = backing.height * scale;
  const ox = (canvas.width - dw) / 2, oy = (canvas.height - dh) / 2;
  fit = { scale, offsetX: ox, offsetY: oy, w: backing.width, h: backing.height };
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(backing, ox, oy, dw, dh);
}

function mapCoords(clientX, clientY) {
  if (!backing) return null;
  const rect = canvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return null;
  const cx = (clientX - rect.left) * (canvas.width / rect.width);
  const cy = (clientY - rect.top) * (canvas.height / rect.height);
  const x = (cx - fit.offsetX) / fit.scale;
  const y = (cy - fit.offsetY) / fit.scale;
  return { x: Math.max(0, Math.min(fit.w, x)), y: Math.max(0, Math.min(fit.h, y)) };
}

let closed = false;
const router = new InputRouter({
  canvas, send: (m) => gui.input(m), mapCoords, onEscape: () => { router.setCapture(false); canvas.blur(); },
});
router.attach();
router.setCapture(true);
canvas.addEventListener('pointerdown', () => { router.setCapture(true); canvas.focus(); });
canvas.focus();

gui.onFrame(async (f) => {
  if (closed || !f) return;
  try {
    if (f.format === 'rgba-rects' && Array.isArray(f.rects)) {
      ensureBacking(f.w, f.h);
      for (const r of f.rects) {
        backingCtx.putImageData(new ImageData(new Uint8ClampedArray(r.data.buffer || r.data, r.data.byteOffset || 0, r.w * r.h * 4), r.w, r.h), r.x, r.y);
      }
    } else if (f.data) {
      const bmp = await createImageBitmap(new Blob([f.data], { type: 'image/jpeg' }));
      if (closed) { if (bmp.close) bmp.close(); return; }
      ensureBacking(bmp.width, bmp.height);
      backingCtx.drawImage(bmp, 0, 0);
      if (bmp.close) bmp.close();
    }
    draw();
  } catch (_) { /* skip a bad frame */ }
  gui.ackFrame(f.seq);
});

gui.onState((s) => {
  if (!s) return;
  const ov = $('pop-overlay');
  if (s.state === 'running') ov.classList.remove('show');
  else if (s.state === 'starting') { ov.textContent = 'Starting…'; ov.classList.add('show'); }
  else if (s.state === 'error') { ov.textContent = 'X11 error' + (s.message ? ': ' + s.message : ''); ov.classList.add('show'); }
  else if (s.state === 'closed') window.close();
});

gui.onStats((s) => {
  if (s) $('pop-stats').textContent = `${fit.w}×${fit.h}  ${s.fps}fps  ${s.kbps}KB/s`;
});

new ResizeObserver(() => { fitCanvas(); draw(); }).observe(wrap);
fitCanvas();

$('pop-disconnect').addEventListener('click', () => window.close());
window.addEventListener('beforeunload', () => { closed = true; try { router.detach(); } catch (_) {} });
