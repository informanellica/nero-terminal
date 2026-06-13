/**
 * @file InputRouter — captures pointer / wheel / keyboard / IME events on the
 * GUI canvas and forwards them to the remote GUI session as the neutral input
 * messages understood by the backends (see backend/gui-cdp-backend). Pixel
 * coordinates are mapped from client space to remote space by a caller-supplied
 * mapper (which knows the canvas letterboxing). `Ctrl+]` is intercepted locally
 * as the "release keyboard capture" escape hatch and is never forwarded.
 * @module renderer/input-router
 */

/** @param {MouseEvent|KeyboardEvent|WheelEvent} e @returns {string[]} */
function mods(e) {
  const m = [];
  if (e.ctrlKey) m.push('ctrl');
  if (e.altKey) m.push('alt');
  if (e.shiftKey) m.push('shift');
  if (e.metaKey) m.push('meta');
  return m;
}

export class InputRouter {
  /**
   * @param {object} opts
   * @param {HTMLCanvasElement} opts.canvas
   * @param {function(object): void} opts.send      forward an input message to the session.
   * @param {function(number, number): ?{x:number,y:number}} opts.mapCoords  client px -> remote px (or null if outside).
   * @param {function(): void} opts.onEscape        called on Ctrl+] to release capture.
   */
  constructor({ canvas, send, mapCoords, onEscape }) {
    this._canvas = canvas;
    this._send = send;
    this._map = mapCoords;
    this._onEscape = onEscape;
    this._capturing = false;
    this._buttons = 0;
    this._composing = false;
    this._handlers = [];
  }

  /** Bitmask matching the DOM MouseEvent.buttons convention CDP expects. */
  _btnMask(button) { return button === 0 ? 1 : button === 2 ? 2 : button === 1 ? 4 : 0; }

  _on(target, type, fn, opts) {
    target.addEventListener(type, fn, opts);
    this._handlers.push(() => target.removeEventListener(type, fn, opts));
  }

  attach() {
    const c = this._canvas;
    this._on(c, 'pointerdown', (e) => {
      c.focus();
      const p = this._map(e.clientX, e.clientY); if (!p) return;
      this._buttons |= this._btnMask(e.button);
      try { c.setPointerCapture(e.pointerId); } catch (_) {}
      this._send({ type: 'pointer', action: 'down', x: p.x, y: p.y, button: e.button, buttons: this._buttons, modifiers: mods(e) });
    });
    this._on(c, 'pointermove', (e) => {
      const p = this._map(e.clientX, e.clientY); if (!p) return;
      this._send({ type: 'pointer', action: 'move', x: p.x, y: p.y, button: e.button, buttons: this._buttons, modifiers: mods(e) });
    });
    this._on(c, 'pointerup', (e) => {
      const p = this._map(e.clientX, e.clientY);
      this._buttons &= ~this._btnMask(e.button);
      try { c.releasePointerCapture(e.pointerId); } catch (_) {}
      if (p) this._send({ type: 'pointer', action: 'up', x: p.x, y: p.y, button: e.button, buttons: this._buttons, modifiers: mods(e) });
    });
    this._on(c, 'contextmenu', (e) => e.preventDefault());
    this._on(c, 'wheel', (e) => {
      const p = this._map(e.clientX, e.clientY); if (!p) return;
      e.preventDefault();
      this._send({ type: 'wheel', x: p.x, y: p.y, deltaX: e.deltaX, deltaY: e.deltaY, modifiers: mods(e) });
    }, { passive: false });

    // Keyboard (only while capturing and the canvas is focused).
    this._on(c, 'keydown', (e) => {
      if (!this._capturing) return;
      // Ctrl+] -> release capture (never forwarded).
      if (e.ctrlKey && (e.key === ']' || e.code === 'BracketRight')) { e.preventDefault(); this._onEscape(); return; }
      if (this._composing) return;
      e.preventDefault();
      this._send({ type: 'key', action: 'down', key: e.key, code: e.code, modifiers: mods(e) });
    });
    this._on(c, 'keyup', (e) => {
      if (!this._capturing || this._composing) return;
      e.preventDefault();
      this._send({ type: 'key', action: 'up', key: e.key, code: e.code, modifiers: mods(e) });
    });
    this._on(c, 'compositionstart', () => { this._composing = true; });
    this._on(c, 'compositionend', (e) => {
      this._composing = false;
      if (e.data) this._send({ type: 'text', text: e.data });
    });
  }

  /** @param {boolean} on  enable/disable keyboard capture. */
  setCapture(on) { this._capturing = !!on; }
  get capturing() { return this._capturing; }

  detach() {
    for (const off of this._handlers.splice(0)) { try { off(); } catch (_) {} }
    this._buttons = 0; this._capturing = false; this._composing = false;
  }
}
