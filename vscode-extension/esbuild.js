'use strict';

/* Bundles the extension (and ssh2 + the reused SshHost backend) into a single
 * dist/extension.js so the .vsix is self-contained. `vscode` is provided by the
 * host; ssh2's OPTIONAL native bindings are left external — ssh2 wraps those
 * requires in try/catch and falls back to its pure-JS crypto when absent. */

const esbuild = require('esbuild');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/** Mark native (*.node) addons and cpu-features as external. */
const externalNativePlugin = {
  name: 'external-native',
  setup(build) {
    build.onResolve({ filter: /\.node$/ }, (args) => ({ path: args.path, external: true }));
    build.onResolve({ filter: /^cpu-features$/ }, (args) => ({ path: args.path, external: true }));
  },
};

async function main() {
  const ctx = await esbuild.context({
    entryPoints: ['src/extension.js'],
    bundle: true,
    outfile: 'dist/extension.js',
    platform: 'node',
    target: 'node18',
    format: 'cjs',
    sourcemap: !production,
    minify: production,
    external: ['vscode'],
    plugins: [externalNativePlugin],
    logLevel: 'info',
  });
  if (watch) {
    await ctx.watch();
  } else {
    await ctx.rebuild();
    await ctx.dispose();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
