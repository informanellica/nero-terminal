/**
 * @file Renderer for nero-terminal's Tera&nbsp;Term-style window.
 *
 * Architecture:
 * - one **persistent** xterm terminal ({@link module:renderer/renderer~ensureTerminal})
 *   created at startup and always shown, so it always renders (it is never
 *   hidden/re-shown — that previously broke xterm's first paint);
 * - the session **configuration** is an overlay dialog over the terminal,
 *   shown at startup and reopenable from the title-bar gear button;
 * - {@link module:renderer/renderer~startSession} opens a session through
 *   `window.sessionAPI`, then pipes `window.terminalAPI` bytes into the view;
 * - UI text is localised via {@link I18n} (`data-i18n` attributes + `t()`), and
 *   the light/dark theme uses Bootstrap's `data-bs-theme`.
 *
 * The terminal backends (PTY/SSH) and the xterm wrapper come from the shared
 * libraries under `nero_modules/`.
 *
 * @module renderer/renderer
 */

import { TerminalView } from '../nero_modules/terminal/src/frontend/terminal-view.mjs';
import { I18n } from '../nero_modules/i18n/src/i18n.mjs';
import en from './locales/en.mjs';
import ja from './locales/ja.mjs';

const LANG_NAMES = { en: 'English', ja: '日本語' };
const i18n = new I18n({
  locales: { en, ja },
  osLocale: (typeof navigator !== 'undefined' && navigator.language) || 'en',
  getStored: () => { try { return localStorage.getItem('nero-terminal:lang'); } catch (_) { return null; } },
  setStored: (c) => { try { localStorage.setItem('nero-terminal:lang', c); } catch (_) {} },
});

const Terminal = window.Terminal;
const FitAddon = (window.FitAddon && window.FitAddon.FitAddon) || window.FitAddon;
const CanvasAddon = window.CanvasAddon && window.CanvasAddon.CanvasAddon;

// ---- colour themes (xterm palette objects) --------------------------------
const THEMES = {
  'Nero Dark':   { background: '#000000', foreground: '#e6e6e6', cursor: '#00ff66', selectionBackground: '#234876',
                   black:'#000000', red:'#ff5555', green:'#50fa7b', yellow:'#f1fa8c', blue:'#6db3ff',
                   magenta:'#ff79c6', cyan:'#8be9fd', white:'#e6e6e6' },
  'Solarized Dark': { background:'#002b36', foreground:'#839496', cursor:'#93a1a1', selectionBackground: '#0a5163',
                   black:'#073642', red:'#dc322f', green:'#859900', yellow:'#b58900', blue:'#268bd2',
                   magenta:'#d33682', cyan:'#2aa198', white:'#eee8d5' },
  'Solarized Light': { background:'#fdf6e3', foreground:'#657b83', cursor:'#586e75', selectionBackground: '#cfe6f2',
                   black:'#073642', red:'#dc322f', green:'#859900', yellow:'#b58900', blue:'#268bd2',
                   magenta:'#d33682', cyan:'#2aa198', white:'#eee8d5' },
  'Light':       { background: '#ffffff', foreground: '#1e1e1e', cursor: '#1e1e1e', selectionBackground: '#add6ff',
                   black:'#1e1e1e', red:'#c91b00', green:'#00c200', yellow:'#c7c400', blue:'#0225c7',
                   magenta:'#c930c7', cyan:'#00c5c7', white:'#c7c7c7' },
  'Campbell (classic)': { background:'#0c0c0c', foreground:'#cccccc', cursor:'#ffffff', selectionBackground: '#264f78',
                   black:'#0c0c0c', red:'#c50f1f', green:'#13a10e', yellow:'#c19c00', blue:'#0037da',
                   magenta:'#881798', cyan:'#3a96dd', white:'#cccccc' },
};

const $ = (id) => document.getElementById(id);
let shells = [];
let view = null;   // persistent terminal
let conn = null;   // current session wiring
let activeLabel = '';   // label of the current session (for the "(inactive)" marker)
let lastProfile = null; // last connected profile snapshot (for toast "Reconnect")

// ---- monospace font picker (only list fonts actually installed) -----------
const DEFAULT_FONT = 'Cascadia Mono, Consolas, monospace';
// [display name, CSS stack]; stacks always fall back to monospace.
const FONT_CANDIDATES = [
  ['Cascadia Mono', 'Cascadia Mono, Consolas, monospace'],
  ['Cascadia Code', 'Cascadia Code, Consolas, monospace'],
  ['Consolas', 'Consolas, monospace'],
  ['Lucida Console', 'Lucida Console, monospace'],
  ['Courier New', '"Courier New", monospace'],
  ['JetBrains Mono', 'JetBrains Mono, Consolas, monospace'],
  ['Fira Code', 'Fira Code, Consolas, monospace'],
  ['Source Code Pro', 'Source Code Pro, Consolas, monospace'],
  ['DejaVu Sans Mono', 'DejaVu Sans Mono, Consolas, monospace'],
  ['Ubuntu Mono', 'Ubuntu Mono, Consolas, monospace'],
  ['Noto Sans Mono', 'Noto Sans Mono, Consolas, monospace'],
];

// Classic canvas-measure trick: a font is installed if it changes the width of
// a probe string versus a generic base family.
const isFontInstalled = (() => {
  const bases = ['monospace', 'serif', 'sans-serif'];
  const probe = 'mmmmmmmmmmlliWWWW0Ogq@%';
  const size = '72px';
  const ctx = document.createElement('canvas').getContext('2d');
  const baseW = {};
  for (const b of bases) { ctx.font = `${size} ${b}`; baseW[b] = ctx.measureText(probe).width; }
  return (name) => bases.some((b) => {
    ctx.font = `${size} "${name}", ${b}`;
    return ctx.measureText(probe).width !== baseW[b];
  });
})();

function populateFonts() {
  const sel = $('font-family');
  sel.innerHTML = '';
  for (const [name, stack] of FONT_CANDIDATES) {
    if (!isFontInstalled(name)) continue;
    const o = document.createElement('option');
    o.value = stack; o.textContent = name; o.style.fontFamily = stack;
    sel.appendChild(o);
  }
  const gen = document.createElement('option');
  gen.value = 'monospace'; gen.textContent = i18n.t('fonts.system'); gen.style.fontFamily = 'monospace';
  sel.appendChild(gen);
  // Prefer Cascadia Mono if present, else the first option.
  sel.value = DEFAULT_FONT;
  if (sel.selectedIndex < 0) sel.selectedIndex = 0;
}

// ---- light / dark UI theme (Bootstrap default) ----------------------------
const THEME_KEY = 'nero-terminal:ui-theme';
// Remembers the "open the default terminal at startup" preference.
const AUTO_OPEN_KEY = 'nero-terminal:auto-open-default';
/**
 * Apply the Bootstrap light/dark UI theme, swap the moon/sun icon, and ask the
 * main process to recolour the native title-bar overlay to match.
 * @param {'dark'|'light'} theme
 */
function setUiTheme(theme) {
  document.documentElement.setAttribute('data-bs-theme', theme);
  const icon = document.querySelector('#btn-theme i');
  if (icon) icon.className = theme === 'dark' ? 'bi bi-moon-stars' : 'bi bi-sun';
  if (window.windowAPI) window.windowAPI.setTitleBarTheme(theme === 'dark');
}
function initUiTheme() {
  let saved; try { saved = localStorage.getItem(THEME_KEY); } catch (_) {}
  setUiTheme(saved || 'dark');
}
function toggleUiTheme() {
  const next = document.documentElement.getAttribute('data-bs-theme') === 'dark' ? 'light' : 'dark';
  setUiTheme(next);
  try { localStorage.setItem(THEME_KEY, next); } catch (_) {}
}

// ---- persistent terminal --------------------------------------------------
/**
 * Create the single, persistent {@link TerminalView} (xterm + fit + canvas
 * renderer) once and mount it into `#terminal`. Idempotent. Because the terminal
 * is created while visible and never hidden, xterm always paints correctly.
 */
function ensureTerminal() {
  if (view) return;
  view = new TerminalView({
    Terminal, FitAddon,
    xtermOptions: { fontFamily: 'Cascadia Mono, Consolas, monospace', fontSize: 14, scrollback: 1000, theme: THEMES['Nero Dark'] },
  });
  view.open($('terminal'));
  if (CanvasAddon) { try { view.term.loadAddon(new CanvasAddon()); } catch (_) {} }
  view.fitOnWindowResize();
  requestAnimationFrame(() => view.fit());

  // PuTTY / Tera Term style: copy to the clipboard as soon as text is selected
  // (no Ctrl+C needed). Fires on every selection change; skip empty selections.
  view.term.onSelectionChange(() => {
    const sel = view.term.getSelection();
    if (sel && window.windowAPI && window.windowAPI.copyText) window.windowAPI.copyText(sel);
  });

  // PuTTY / Tera Term style: right-click pastes the clipboard into the terminal.
  // term.paste() honours bracketed-paste mode and flows through onData to the
  // backend, just like typed input.
  $('terminal').addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const text = window.windowAPI && window.windowAPI.readText ? window.windowAPI.readText() : '';
    if (text) view.term.paste(text);
    view.focus();
  });
}

// ---- settings overlay -----------------------------------------------------
/** @returns {boolean} whether the configuration overlay is currently shown. */
function settingsOpen() { return $('settings-overlay').classList.contains('d-flex'); }
/** Show the session-configuration overlay over the terminal and focus the host field. */
function openSettings() {
  $('settings-overlay').classList.replace('d-none', 'd-flex');
  const h = $('host'); if (h && connType() === 'ssh') setTimeout(() => h.focus(), 0);
}
/** Hide the configuration overlay and return focus to the terminal. */
function closeSettings() {
  $('settings-overlay').classList.replace('d-flex', 'd-none');
  if (view) view.focus();
}

// ---- category nav / connection type ---------------------------------------
function selectCategory(cat) {
  document.querySelectorAll('.cat-list .cat').forEach((li) => li.classList.toggle('active', li.dataset.cat === cat));
  document.querySelectorAll('.cat-panel').forEach((p) => { p.hidden = p.dataset.cat !== cat; });
}
function connType() {
  const r = document.querySelector('input[name="ctype"]:checked');
  return r ? r.value : 'ssh';
}
function applyConnType() {
  const t = connType();
  document.querySelectorAll('#settings-overlay [data-when]').forEach((el) => { el.hidden = el.dataset.when !== t; });
}

// ---- profiles -------------------------------------------------------------
/**
 * Snapshot the configuration form into a {@link SessionProfile}-shaped object,
 * used both for saving and for opening a session.
 * @returns {object}
 */
function formToProfile() {
  return {
    name: $('profile-name').value.trim() || 'Default',
    type: connType(),
    host: $('host').value.trim(), port: Number($('port').value) || 22,
    username: $('username').value.trim(), termType: $('term-type').value.trim() || 'xterm-256color',
    password: $('password').value, keyPath: $('key-path').value.trim(), passphrase: $('passphrase').value,
    x11: $('x11-forward').checked,
    shellId: $('shell').value, customShell: $('custom-shell').value, args: $('args').value, cwd: $('cwd').value,
    cols: Number($('cols').value) || 120, rows: Number($('rows').value) || 32,
    scrollback: Number($('scrollback').value) || 1000,
    fontFamily: $('font-family').value, fontSize: Number($('font-size').value) || 14,
    cursorStyle: $('cursor-style').value, cursorBlink: $('cursor-blink').checked,
    theme: $('theme').value,
  };
}
function applyProfile(p) {
  $('profile-name').value = p.name || '';
  const t = p.type === 'local' ? 'local' : 'ssh';
  const radio = document.getElementById('ctype-' + t); if (radio) radio.checked = true;
  applyConnType();
  $('host').value = p.host || ''; $('port').value = p.port || 22;
  $('username').value = p.username || ''; $('term-type').value = p.termType || 'xterm-256color';
  $('key-path').value = p.keyPath || '';
  $('password').value = ''; $('passphrase').value = '';
  $('shell').value = shells.some((s) => s.id === p.shellId) || p.shellId === 'custom' ? p.shellId : (shells[0] && shells[0].id);
  $('custom-row').hidden = $('shell').value !== 'custom';
  $('custom-shell').value = p.customShell || ''; $('args').value = p.args || ''; $('cwd').value = p.cwd || '';
  $('cols').value = p.cols || 120; $('rows').value = p.rows || 32; $('scrollback').value = p.scrollback || 1000;
  const fam = p.fontFamily || DEFAULT_FONT;
  const fsel = $('font-family');
  fsel.value = fam;
  if (fsel.selectedIndex < 0) { // a saved font that isn't in the detected list — keep it usable
    const o = document.createElement('option'); o.value = fam; o.textContent = (fam.split(',')[0] || fam).replace(/"/g, ''); o.style.fontFamily = fam;
    fsel.appendChild(o); fsel.value = fam;
  }
  $('font-size').value = p.fontSize || 14;
  $('cursor-style').value = p.cursorStyle || 'block'; $('cursor-blink').checked = !!p.cursorBlink;
  if ($('x11-forward')) $('x11-forward').checked = !!p.x11;
  if (p.theme && THEMES[p.theme]) $('theme').value = p.theme;
}
async function refreshProfiles(selectName) {
  const list = await window.sessionAPI.profiles.list();
  const sel = $('profile-list'); sel.innerHTML = '';
  for (const p of list) {
    const o = document.createElement('option'); o.value = JSON.stringify(p);
    o.textContent = p.name + (p.type === 'local' ? '  ' + i18n.t('tag.local') : (p.host ? `  (${p.host})` : ''));
    if (p.name === selectName) o.selected = true;
    sel.appendChild(o);
  }
}
async function saveProfile() {
  const p = formToProfile();
  await window.sessionAPI.profiles.save(Object.assign({}, p, { password: '', passphrase: '' }));
  await refreshProfiles(p.name);
  flash(i18n.t('msg.saved', { name: p.name }), false);
}
async function deleteProfile() {
  if (!$('profile-list').value) return;
  await window.sessionAPI.profiles.delete(JSON.parse($('profile-list').value).name);
  await refreshProfiles();
}

// ---- launch resolution ----------------------------------------------------
/**
 * Turn a form snapshot into the payload for `window.sessionAPI.open`, plus a
 * short display `label` for the title bar. Throws a localised Error if a
 * required field (SSH host, or a custom command / shell) is missing.
 * @param {object} p  form values from {@link formToProfile}
 * @returns {object}  a `sessionAPI.open` payload with `type`, connection fields and a display `label`.
 */
function resolveLaunch(p) {
  if (p.type === 'local') {
    const extra = (p.args || '').trim() ? p.args.trim().split(/\s+/) : [];
    if (p.shellId === 'custom') {
      if (!p.customShell.trim()) throw new Error(i18n.t('errors.no_command'));
      return { type: 'local', shell: p.customShell.trim(), args: extra, cwd: p.cwd, label: p.customShell.trim() };
    }
    const desc = shells.find((s) => s.id === p.shellId) || shells[0];
    if (!desc) throw new Error(i18n.t('errors.no_shell'));
    return { type: 'local', shell: desc.shell, args: (desc.args || []).concat(extra), cwd: p.cwd, label: desc.label };
  }
  if (!p.host) throw new Error(i18n.t('errors.no_host'));
  return {
    type: 'ssh', host: p.host, port: p.port, username: p.username, term: p.termType,
    password: p.password, keyPath: p.keyPath, passphrase: p.passphrase, x11: p.x11,
    label: `${p.username ? p.username + '@' : ''}${p.host}:${p.port}`,
  };
}

// ---- start a session in the persistent terminal ---------------------------
/**
 * Open a session for the current form values and connect it to the persistent
 * terminal. Tears down any previous session, applies per-session xterm options
 * (font / theme / scrollback / cursor) and resets the screen, buffers early
 * output until the view is ready, then pipes `terminalAPI` ⇄ the view and closes
 * the overlay. Validation / connection errors are shown inline via {@link flash}.
 * @param {object} [profileOverride]  reconnect with this saved snapshot instead
 *   of reading the form (used by the disconnect toast's "Reconnect" button).
 * @returns {Promise<void>}
 */
async function startSession(profileOverride) {
  flash('', false);
  const p = profileOverride || formToProfile();
  let l; try { l = resolveLaunch(p); } catch (e) { return flash(e.message, true); }

  // tear down any previous session
  if (conn) { conn.dispose(); conn = null; }
  try { await window.sessionAPI.close(); } catch (_) {}

  // apply per-session options to the persistent terminal, then clear it
  const t = view.term;
  t.options.fontFamily = p.fontFamily; t.options.fontSize = p.fontSize;
  t.options.cursorStyle = p.cursorStyle; t.options.cursorBlink = p.cursorBlink;
  t.options.scrollback = p.scrollback; t.options.theme = THEMES[p.theme] || THEMES['Nero Dark'];
  t.reset();

  // buffer output until the terminal is ready to show it
  const buffered = [];
  let sink = (d) => buffered.push(d);
  const offData = window.terminalAPI.onData((d) => sink(d));

  try {
    await window.sessionAPI.open(Object.assign({ cols: p.cols, rows: p.rows }, l));
  } catch (e) {
    offData();
    return flash(i18n.t('errors.failed', { msg: (e && e.message) || '' }), true);
  }

  closeSettings();
  activeLabel = l.label;
  lastProfile = p;
  hideExitToast();
  $('tb-session').textContent = '— ' + l.label;
  view.fit();
  sink = (d) => view.write(d);
  for (const d of buffered) view.write(d);
  buffered.length = 0;

  const offInput = view.onInput((d) => window.terminalAPI.sendInput(d));
  const offResize = view.onResize((c, r) => window.terminalAPI.resize(c, r));
  const offExit = window.terminalAPI.onExit(() => handleSessionExit());
  window.terminalAPI.resize(view.cols, view.rows);
  view.focus();
  conn = { dispose() { offData(); offInput(); offResize(); offExit(); } };
}

/**
 * Called when the active session's backend exits — a remote SSH disconnect or a
 * local shell exit. Marks the title bar `(inactive)` (PuTTY style), prints a
 * notice in the terminal, and shows a bottom-right toast. Intentional teardown
 * (opening another session / closing) unsubscribes first, so it does not fire.
 */
function handleSessionExit() {
  $('tb-session').textContent = '— ' + activeLabel + ' (inactive)';
  if (view) view.write(`\r\n\x1b[33m[${i18n.t('msg.disconnected')}]\x1b[0m\r\n`);
  showExitToast(i18n.t('msg.disconnected') + (activeLabel ? ` — ${activeLabel}` : ''));
}

/** Show the bottom-right disconnect toast with a message. */
function showExitToast(msg) {
  const el = $('exit-toast'); if (!el) return;
  $('exit-toast-msg').textContent = msg;
  el.classList.add('show');
}

/** Hide the disconnect toast. */
function hideExitToast() {
  const el = $('exit-toast'); if (el) el.classList.remove('show');
}

/** Reconnect to the last session (from the disconnect toast). */
function reconnectLast() {
  if (!lastProfile) return;
  hideExitToast();
  startSession(lastProfile);
}

/**
 * Apply the current appearance settings (font, cursor, scrollback, colour theme)
 * to the live persistent terminal immediately, without reopening the session —
 * so changes such as a larger font are reflected at once, even mid-session.
 */
function applyLiveTerminalOptions() {
  if (!view) return;
  const t = view.term;
  t.options.fontFamily = $('font-family').value || DEFAULT_FONT;
  t.options.fontSize = Number($('font-size').value) || 14;
  t.options.cursorStyle = $('cursor-style').value || 'block';
  t.options.cursorBlink = $('cursor-blink').checked;
  t.options.scrollback = Number($('scrollback').value) || 1000;
  t.options.theme = THEMES[$('theme').value] || THEMES['Nero Dark'];
  view.fit();
}

/**
 * Open the default local shell immediately, skipping manual configuration.
 * Backs the "open the default terminal at startup" toggle (and is a sensible
 * fallback when a requested profile cannot be opened).
 * @returns {Promise<void>}
 */
async function startDefaultSession() {
  if (!shells.length) { openSettings(); return; }
  const radio = $('ctype-local'); if (radio) radio.checked = true;
  applyConnType();
  $('shell').value = shells[0].id;
  $('custom-row').hidden = true;
  await startSession();
}

/**
 * Load a saved session profile by name and start it immediately. Invoked when a
 * Windows jump-list entry (or a `--open-profile` launch argument) selects a
 * saved session; shows the settings dialog if the profile is missing.
 * @param {string} name  the saved session's name.
 * @returns {Promise<void>}
 */
async function openProfileByName(name) {
  try {
    const list = await window.sessionAPI.profiles.list();
    const p = list.find((x) => x.name === name);
    if (!p) { openSettings(); flash(i18n.t('errors.profile_not_found', { name }), true); return; }
    applyProfile(p);
    await startSession();
  } catch (e) {
    openSettings();
    flash(i18n.t('errors.failed', { msg: (e && e.message) || '' }), true);
  }
}

/**
 * Show a transient message in the dialog footer.
 * @param {string} msg            Message text (empty to clear).
 * @param {boolean} isError       Red (error) when `true`, muted (info) otherwise.
 */
function flash(msg, isError) {
  const el = $('cfg-error');
  el.textContent = msg;
  el.classList.toggle('text-danger', !!isError);
  el.classList.toggle('text-secondary', !isError);
}

// ---- init -----------------------------------------------------------------
/**
 * Bootstrap the renderer: localise the static DOM and wire the language picker,
 * create the persistent terminal, attach every event handler **synchronously**
 * (so the buttons work even if async setup is slow or fails), populate the
 * colour-theme and installed-font pickers, show the settings overlay, then load
 * the detected shells and saved sessions.
 * @returns {Promise<void>}
 */
async function init() {
  // On macOS the native traffic-light controls sit at the top-left, so the title
  // bar must reserve room there instead of on the right (Windows/Linux overlay).
  if (window.windowAPI && window.windowAPI.platform === 'darwin') {
    document.documentElement.classList.add('platform-mac');
  }
  initUiTheme();
  ensureTerminal();

  // localisation: translate the static DOM, then wire the language picker
  i18n.init();
  document.documentElement.lang = i18n.getLocale();
  const langSel = $('lang');
  langSel.innerHTML = '';
  for (const code of i18n.available()) {
    const o = document.createElement('option'); o.value = code; o.textContent = LANG_NAMES[code] || code; langSel.appendChild(o);
  }
  langSel.value = i18n.getLocale();
  langSel.addEventListener('change', () => {
    i18n.setLocale(langSel.value);
    document.documentElement.lang = langSel.value;
    refreshDynamicLabels();
  });

  // wire handlers (synchronously — never gated behind an await)
  $('btn-theme').addEventListener('click', toggleUiTheme);
  $('btn-settings').addEventListener('click', openSettings);
  $('btn-close-settings').addEventListener('click', closeSettings);
  $('exit-toast-close').addEventListener('click', hideExitToast);
  $('exit-toast-reconnect').addEventListener('click', reconnectLast);
  $('btn-open').addEventListener('click', () => startSession());
  $('btn-quit').addEventListener('click', () => window.close());
  $('btn-browse').addEventListener('click', async () => { const d = await window.sessionAPI.browseDir(); if (d) $('cwd').value = d; });
  $('btn-browse-key').addEventListener('click', async () => { const k = await window.sessionAPI.browseKey(); if (k) $('key-path').value = k; });
  $('btn-save').addEventListener('click', saveProfile);
  $('btn-load').addEventListener('click', () => { if ($('profile-list').value) applyProfile(JSON.parse($('profile-list').value)); });
  $('btn-delete').addEventListener('click', deleteProfile);
  document.querySelectorAll('.cat-list .cat').forEach((li) => li.addEventListener('click', () => selectCategory(li.dataset.cat)));
  document.querySelectorAll('input[name="ctype"]').forEach((r) => r.addEventListener('change', applyConnType));
  $('shell').addEventListener('change', () => { $('custom-row').hidden = $('shell').value !== 'custom'; });
  // live-apply appearance changes to the running terminal (font size, etc.)
  ['font-family', 'font-size', 'cursor-style', 'cursor-blink', 'scrollback', 'theme'].forEach((id) => {
    const el = $(id); if (el) el.addEventListener('change', applyLiveTerminalOptions);
  });
  $('font-size').addEventListener('input', applyLiveTerminalOptions);
  $('profile-list').addEventListener('dblclick', () => {
    if ($('profile-list').value) { applyProfile(JSON.parse($('profile-list').value)); startSession(); }
  });
  document.querySelectorAll('#settings-overlay input').forEach((inp) => {
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); startSession(); } });
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && settingsOpen()) closeSettings(); });

  $('theme').innerHTML = '';
  for (const name of Object.keys(THEMES)) {
    const o = document.createElement('option'); o.value = name; o.textContent = name; $('theme').appendChild(o);
  }
  populateFonts();
  applyConnType();

  // "open the default terminal at startup" toggle: restore + persist preference
  let autoOpen = false;
  try { autoOpen = localStorage.getItem(AUTO_OPEN_KEY) === 'true'; } catch (_) {}
  $('auto-open-default').checked = autoOpen;
  $('auto-open-default').addEventListener('change', () => {
    try { localStorage.setItem(AUTO_OPEN_KEY, $('auto-open-default').checked ? 'true' : 'false'); } catch (_) {}
  });

  // async population (must not break the handlers above)
  try { shells = await window.sessionAPI.detectShells(); } catch (_) { shells = []; }
  $('shell').innerHTML = '';
  for (const s of shells) {
    const o = document.createElement('option'); o.value = s.id; o.textContent = s.label; $('shell').appendChild(o);
  }
  const cu = document.createElement('option'); cu.value = 'custom'; cu.textContent = i18n.t('shell.custom'); $('shell').appendChild(cu);
  try { await refreshProfiles(); } catch (_) {}

  // open a saved session if launched from a jump-list entry / --open-profile arg
  // (the preload buffers an early request and flushes it the moment we listen)
  let launchedFromArg = false;
  if (window.sessionAPI.onOpenProfile) {
    window.sessionAPI.onOpenProfile((name) => { launchedFromArg = true; openProfileByName(name); });
  }

  // startup: open the requested profile, the default terminal, or the dialog
  if (!launchedFromArg && !settingsOpen()) {
    if (autoOpen && shells.length) await startDefaultSession();
    else openSettings();   // Tera Term style: show the dialog over the blank terminal
  }
}

// Re-label dynamically-generated option text after a language change.
function refreshDynamicLabels() {
  const sc = [...$('shell').options].find((o) => o.value === 'custom'); if (sc) sc.textContent = i18n.t('shell.custom');
  const fm = [...$('font-family').options].find((o) => o.value === 'monospace'); if (fm) fm.textContent = i18n.t('fonts.system');
  refreshProfiles();
}

init();
