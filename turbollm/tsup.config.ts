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
  external: ['node:sqlite'],
  noExternal: [],
})
