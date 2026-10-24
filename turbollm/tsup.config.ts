import { defineConfig } from 'tsup'

// ONE build pass for every entry — this is load-bearing. code-routes.js and code-run-manager.js
// are loaded at runtime by cli.js (server.ts's registerCodeRoutesIfSupported, cli.ts's
// CodeRunManager construction) into the SAME process, and they share module-level singletons
// with it: session-auth.ts's `sessionAuth` (live thinking-budget/effort overrides the gateway
// reads), approval-gate.ts's pending tool-approval map (Code "ask" mode, approved through
// chat-routes.ts). These entries used to be a second, separate tsup invocation, which bundled its
// own copy of every module it reached — a second registry and a second approval map that cli.js
// never saw, so an approval or an override written on one side was invisible on the other (only
// in the built package: tsx and the tests share one module graph). In one pass esbuild puts each
// shared module in a chunk imported by every entry that reaches it, so there is one instance.
//
// That separate pass was originally there to keep code-session.ts's
// `@earendil-works/pi-coding-agent` chain out of cli.js's static output (TurboLLM Android,
// Spike D: its `\p{...}` regexes do not even parse on the phone's runtime). Splitting cannot leak
// it: esbuild assigns a module to a chunk by which entries STATICALLY reach it, and cli.js
// imports only the chunks for modules it reaches itself. The two code entries are loaded through
// a computed pathToFileURL(join(...)) specifier esbuild cannot follow (see cli.ts/server.ts), and
// the leak that was seen live came from a static import (ext/run-manager.ts → code-run-manager.ts,
// since split out to code/run-buffer.ts). Android also no longer uses this output at all — it has
// its own separate build pass, tsup.android.config.ts.
export default defineConfig({
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
    // The Code/Agents feature's entries, imported lazily by cli.js (see the top of this file).
    'code-routes': 'src/code/code-routes.ts',
    'code-run-manager': 'src/code/code-run-manager.ts',
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
  // child_process is not supported" crash at runtime. Only the code-routes/code-run-manager
  // entries reach them (cli.js never does — see the top of this file).
  // sql.js (Android's node:sqlite fallback — sqlite-adapter.ts) locates its own .wasm
  // file relative to its OWN package folder at runtime; bundling it into cli.js would
  // break that resolution (the wasm wouldn't be found relative to a single dist/cli.js).
  // Externalizing keeps it a real node_modules dependency the Android app ships alongside
  // dist/, so sql.js's normal resolution logic works unmodified.
  external: ['node:sqlite', '@earendil-works/pi-ai', '@earendil-works/pi-coding-agent', 'sql.js'],
  noExternal: [],
})
