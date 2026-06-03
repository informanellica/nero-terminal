'use strict';

/**
 * @file Build entry — delegates to the shared Nero build pipeline (`runBuild`)
 * in nero-electron-lib, so every Nero app builds the same way.
 *
 * Usage: `node scripts/build.js <release|debug> <win|mac|linux>`
 * (the args are forwarded to `runBuild` from `process.argv`). A `release`
 * Windows build code-signs with the configured EV certificate; a `debug` build
 * skips signing. Output goes to `dist/` (release) or `dist-debug/` (debug).
 *
 * @module scripts/build
 * @see module:main/main
 */

const path = require('path');
require('../nero_modules/electron').runBuild({ projectDir: path.join(__dirname, '..') });
