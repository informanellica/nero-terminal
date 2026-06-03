/**
 * @file `npm test` — a fast, dependency-free smoke check that the app is wired up:
 * verifies required entry files / icons exist and that the JS sources parse
 * (`node --check`). Exits non-zero on the first failure. No Electron required.
 * @module scripts/smoke-check
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const root = path.join(__dirname, '..');
const pkg = require(path.join(root, 'package.json'));
let failed = false;

/**
 * Record a check result.
 * @param {string} label  Human-readable description.
 * @param {boolean} ok    Whether the check passed.
 */
function check(label, ok) {
  if (ok) {
    console.log(`  OK  ${label}`);
  } else {
    console.log(`  FAIL  ${label}`);
    failed = true;
  }
}

const exists = (...p) => fs.existsSync(path.join(root, ...p));

console.log(`Smoke check: ${pkg.name} v${pkg.version}\n`);

// Required entry files
check('main/main.js exists', exists('main', 'main.js'));
check('main/preload.js exists', exists('main', 'preload.js'));
check('renderer/index.html exists', exists('renderer', 'index.html'));
check('renderer/renderer.mjs exists', exists('renderer', 'renderer.mjs'));

// Build icons
check('assets/icon.ico exists', exists('assets', 'icon.ico'));
check('assets/icon.png exists', exists('assets', 'icon.png'));

// nero_modules submodule layout (must be kept; main/preload require from here)
check('nero_modules/terminal/src exists', exists('nero_modules', 'terminal', 'src'));
check('nero_modules/electron exists', exists('nero_modules', 'electron'));
check('nero_modules/terminal/src/backend/pty-host.js exists', exists('nero_modules', 'terminal', 'src', 'backend', 'pty-host.js'));
check('nero_modules/terminal/src/transport/electron-main.js exists', exists('nero_modules', 'terminal', 'src', 'transport', 'electron-main.js'));
check('nero_modules/terminal/src/transport/electron-preload.js exists', exists('nero_modules', 'terminal', 'src', 'transport', 'electron-preload.js'));
check('nero_modules/electron/index.js exists', exists('nero_modules', 'electron', 'index.js'));

// Guard the layout rule: the old node_modules/nero-terminal-lib must NOT be reintroduced.
check('node_modules/nero-terminal-lib is absent (use nero_modules layout)', !exists('node_modules', 'nero-terminal-lib'));

// electron-builder config packages nero_modules
const files = (pkg.build && pkg.build.files) || [];
check('build.files includes nero_modules/**/*', files.includes('nero_modules/**/*'));
check('build win icon configured', !!(pkg.build && pkg.build.win && pkg.build.win.icon));

// Syntax checks (node --check does not execute requires, so native/submodule deps are fine)
for (const file of ['main/main.js', 'main/preload.js', 'renderer/renderer.mjs']) {
  try {
    execSync(`node --check ${file}`, { cwd: root, stdio: 'pipe' });
    check(`${file} syntax valid`, true);
  } catch {
    check(`${file} syntax valid`, false);
  }
}

console.log('');
if (failed) {
  console.error('Smoke check FAILED');
  process.exit(1);
} else {
  console.log('All checks passed');
}
