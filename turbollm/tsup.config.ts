import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/cli.ts'],
  format: ['esm'],
  clean: true,
  target: 'node22',
  // The package `bin` points at the built file; this shebang makes the global
  // `turbollm` command (npm install -g / npx / npm link) actually run under Node.
  banner: { js: '#!/usr/bin/env node' },
  // node:sqlite is a Node 22+ built-in; mark explicitly external so the
  // node: prefix is preserved in the bundle (esbuild strips it otherwise).
  //
  // The pi SDK (and its transitive deps like cross-spawn) use dynamic CommonJS
  // `require('child_process')`, which esbuild cannot inline into an ESM bundle —
  // bundling them produces a runtime "Dynamic require of child_process is not
  // supported" crash. Mark them external so they're resolved from node_modules at
  // runtime (npm ships them as dependencies), exactly like they work under tsx in dev.
  external: ['node:sqlite', '@earendil-works/pi-coding-agent', '@earendil-works/pi-ai'],
  noExternal: [],
})
