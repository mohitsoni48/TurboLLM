#!/usr/bin/env node
// Hand-written launcher shim — NOT bundled by tsup. It runs before the bundled
// daemon (dist/cli.js) loads, so it can do two things that must happen before
// node:sqlite is imported (the bundle hoists that import, emitting an experimental
// warning that PowerShell renders as a scary red error block on every run):
//   1. Guard the Node version with a friendly message (node:sqlite needs Node 22.13+ —
//      that's when node:sqlite became available WITHOUT the --experimental-sqlite flag;
//      on 22.5.0-22.12.x it's registered only behind that flag, so importing it bare
//      throws ERR_UNKNOWN_BUILTIN_MODULE: "No such built-in module: node:sqlite"
//      (GitHub #40) even though `node -v` reports 22.x).
//   2. Register a 'warning' filter that swallows the node:sqlite experimental notice
//      while still printing every other warning.
// Then it hands off to the real CLI via dynamic import (same process; argv intact).
const [major, minor] = process.versions.node.split('.').map(Number)
if (major < 22 || (major === 22 && minor < 13)) {
  process.stderr.write(
    `TurboLLM requires Node.js 22.13.0 or newer (needs node:sqlite unflagged).\n` +
      `You are running Node.js ${process.versions.node}.\n` +
      `Please upgrade: https://nodejs.org\n`,
  )
  process.exit(1)
}

process.on('warning', (w) => {
  if (w.name === 'ExperimentalWarning' && /SQLite/i.test(w.message)) return
  process.stderr.write(`${w.stack ?? `${w.name}: ${w.message}`}\n`)
})

await import('../dist/cli.js')
