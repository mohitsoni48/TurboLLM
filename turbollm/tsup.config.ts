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
  // pi-ai/pi-coding-agent pull in cross-spawn (dynamic require of child_process)
  // which esbuild cannot bundle; externalizing avoids the "Dynamic require of
  // child_process is not supported" crash at runtime.
  external: ['node:sqlite', '@earendil-works/pi-ai', '@earendil-works/pi-coding-agent'],
  noExternal: [],
})
