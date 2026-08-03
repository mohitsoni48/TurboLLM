import { defineConfig } from 'tsup'

export default defineConfig({
  // run-code-worker is a second, independent entry point (not imported/bundled into cli.js) —
  // execRunCode in builtin.ts spawns it as a real node:worker_threads Worker at runtime, which
  // needs an actual file on disk beside the built cli.js, not something inlined into that bundle.
  // Object form (not an array) so tsup names the output by these keys FLAT in dist/ — an array
  // entry preserves each file's src/-relative subdirectory (dist/tools/run-code-worker.js),
  // which would land one directory deeper than cli.js and break builtin.ts's same-directory
  // `new URL('./run-code-worker.js', import.meta.url)` resolution at runtime.
  entry: { cli: 'src/cli.ts', 'run-code-worker': 'src/tools/run-code-worker.ts' },
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
