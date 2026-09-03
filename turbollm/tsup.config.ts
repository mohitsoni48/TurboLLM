import { defineConfig } from 'tsup'

// Two independent build passes (not one multi-entry config) — this is load-bearing, not
// stylistic. tsup/esbuild's `splitting: true` (its default for multi-entry ESM builds)
// shares code across ALL entries in ONE build pass, grouped by module-graph reachability,
// not by feature boundaries. Confirmed live (TurboLLM Android, Spike D): code-session.ts's
// `@earendil-works/pi-coding-agent` imports — already gated behind a platform check and a
// dynamic `import()` (server.ts's registerCodeRoutesIfSupported, cli.ts's CodeRunManager
// construction), specifically so that dependency chain (which uses `\p{...}` regex syntax
// TurboLLM Android's embedded runtime can't even parse) is never touched there — still got
// pulled into cli.js's own static output. Giving code-routes.ts/code-run-manager.ts their
// own entry NAMES in the SAME config wasn't enough: esbuild still created one shared chunk
// file (containing BOTH ordinary utilities cli.ts needs directly, like
// sweepInteractiveCliRuns, AND code-session.ts's pi-coding-agent imports) because both are
// reachable from the same single esbuild invocation. A genuinely SEPARATE tsup invocation
// has no shared-chunk mechanism to leak through at all — the only way to guarantee it.
const mainEntries = defineConfig({
  entry: {
    cli: 'src/cli.ts',
    // run-code-worker is a second, independent entry point (not imported/bundled into
    // cli.js) — execRunCode in builtin.ts spawns it as a real node:worker_threads Worker at
    // runtime, which needs an actual file on disk beside the built cli.js, not something
    // inlined into that bundle. run-code-sandbox is a THIRD, equally independent entry for
    // the same reason: run-code-worker.ts dynamically imports it via a computed
    // same-directory URL (see run-code-worker.ts) instead of a static import, so it also
    // needs to exist as a real file rather than get inlined — a spawned worker_threads
    // Worker doesn't reliably inherit tsx's loader hook for sibling-module resolution
    // (confirmed: fails on Linux, works on Windows), so the fix is to never depend on that
    // hook at all and target a real file directly, in both dev/tsx and the built package alike.
    'run-code-worker': 'src/tools/run-code-worker.ts',
    'run-code-sandbox': 'src/tools/run-code-sandbox.ts',
  },
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
  // child_process is not supported" crash at runtime. They're never actually reached from
  // this pass's own entries (see the code/agents pass below), external here purely as a
  // safety net in case something in this pass's graph ever references them again.
  // sql.js (Android's node:sqlite fallback — sqlite-adapter.ts) locates its own .wasm
  // file relative to its OWN package folder at runtime; bundling it into cli.js would
  // break that resolution (the wasm wouldn't be found relative to a single dist/cli.js).
  // Externalizing keeps it a real node_modules dependency the Android app ships alongside
  // dist/, so sql.js's normal resolution logic works unmodified.
  external: ['node:sqlite', '@earendil-works/pi-ai', '@earendil-works/pi-coding-agent', 'sql.js'],
  noExternal: [],
})

// The Code/Agents feature's own build pass — entirely separate esbuild invocation from
// mainEntries above (see the comment at the top of this file for why that separation
// itself is the fix, not an optimization). `clean: false` so this doesn't wipe out
// mainEntries' output — both passes write into the same dist/ directory.
const codeAgentsEntries = defineConfig({
  entry: {
    'code-routes': 'src/code/code-routes.ts',
    'code-run-manager': 'src/code/code-run-manager.ts',
  },
  format: ['esm'],
  clean: false,
  target: 'node22',
  external: ['node:sqlite', '@earendil-works/pi-ai', '@earendil-works/pi-coding-agent', 'sql.js'],
  noExternal: [],
})

export default [mainEntries, codeAgentsEntries]
