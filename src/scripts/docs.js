/**
 * @file Documentation build — generates the JSDoc API reference in every
 * supported language and wires up a language switcher.
 *
 * Source comments are English only (see README "コーディング規約"); Japanese (and
 * any future language) is produced by post-processing via
 * {@link module:scripts/jsdoc-i18n-plugin} reading `docs-i18n/<lang>.json`.
 *
 * For each language `L` this runs JSDoc with `DOC_LANG=L` into
 * `release-github/docs/src/<L>/`, injects a small language-switch link into
 * every generated page, then writes a `release-github/docs/src/index.html`
 * that redirects to the visitor's preferred language.
 *
 * Run: `npm run docs`
 *
 * @module scripts/docs
 */

'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const JSDOC = path.join(ROOT, 'node_modules', 'jsdoc', 'jsdoc.js');
const CONFIG = path.join(ROOT, 'jsdoc.json');
const OUT = path.join(ROOT, '..', 'docs', 'src');

const LANGS = ['en', 'ja'];
const DEFAULT_LANG = 'en';

// Injected on every page: a language <select> (EN / 日本語) in the navbar.
// Changing it navigates to the same page under the other /<lang>/ path.
const LANGS_UI = [['en', 'EN'], ['ja', '日本語']];
const SWITCH_SCRIPT = `<script>(function(){
  var LANGS = ${JSON.stringify(LANGS_UI)};
  var m = location.pathname.match(/\\/(en|ja)\\//);
  if (!m) return;
  var cur = m[1];
  function place(){
    var wrap = document.createElement('div');
    wrap.className = 'navbar-right-item';
    var sel = document.createElement('select');
    sel.setAttribute('aria-label', 'language');
    sel.title = 'Language / 言語';
    sel.style.cssText = 'background:transparent;color:inherit;border:1px solid rgba(128,128,128,.45);border-radius:6px;font-size:.8rem;padding:.15rem .35rem;cursor:pointer;';
    LANGS.forEach(function(l){
      var o = document.createElement('option');
      o.value = l[0]; o.textContent = l[1];
      o.style.color = 'initial';
      if (l[0] === cur) o.selected = true;
      sel.appendChild(o);
    });
    sel.addEventListener('change', function(){
      if (sel.value === cur) return;
      location.href = location.pathname.replace('/' + cur + '/', '/' + sel.value + '/') + location.hash;
    });
    wrap.appendChild(sel);
    var nav = document.querySelector('.navbar-right-items');
    if (nav) { nav.insertBefore(wrap, nav.firstChild); }
    else { wrap.style.cssText = 'position:fixed;top:10px;right:14px;z-index:9999;'; document.body.appendChild(wrap); }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', place);
  else place();
})();</script>`;

function generate(lang) {
    const dest = path.join(OUT, lang);
    process.stdout.write(`[docs] generating ${lang} -> ${path.relative(ROOT, dest)}\n`);
    execFileSync(process.execPath, [JSDOC, '-c', CONFIG, '-d', dest], {
        stdio: 'inherit',
        env: { ...process.env, DOC_LANG: lang },
    });
    injectSwitcher(dest);
}

function injectSwitcher(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            injectSwitcher(full);
        } else if (entry.name.endsWith('.html')) {
            let html = fs.readFileSync(full, 'utf8');
            if (html.includes('</body>') && !html.includes('Switch language')) {
                html = html.replace('</body>', `${SWITCH_SCRIPT}\n</body>`);
                fs.writeFileSync(full, html);
            }
        }
    }
}

function writeRedirect() {
    const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>nero-terminal — source documentation</title>
<script>
  var l = (navigator.language || '').toLowerCase().indexOf('ja') === 0 ? 'ja' : '${DEFAULT_LANG}';
  location.replace(l + '/index.html');
</script>
<meta http-equiv="refresh" content="0; url=${DEFAULT_LANG}/index.html">
</head>
<body><a href="${DEFAULT_LANG}/index.html">Documentation</a></body>
</html>
`;
    fs.writeFileSync(path.join(OUT, 'index.html'), html);
}

// Clean previous output (fs.rmSync — never shell rm -rf in this workspace).
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

LANGS.forEach(generate);
writeRedirect();

process.stdout.write(`[docs] done: ${LANGS.join(', ')} + redirect index\n`);
