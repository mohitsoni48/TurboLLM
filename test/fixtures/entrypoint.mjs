#!/usr/bin/env node
// Test harness entry point — starts the HF fixture server and then the daemon.
// FIXTURE_MODE (from docker-compose env) selects which failure to inject.

import { startFixture } from './hf-server.mjs'

const fixturePort = 8080
const fixture = startFixture(fixturePort)
fixture.on('error', (err) => {
  // Port might be taken; the real fixture server just ignores this.
  process.stderr.write(`fixture bind warning: ${err.message}\n`)
})

// Start the daemon (already built inside the image). The real tsup output is
// dist/cli.js (see turbollm/package.json's "build" script) — dist/index.js
// does not exist and this line never actually started a daemon until fixed.
const { spawn } = await import('node:child_process')
const daemon = spawn('node', ['dist/cli.js', '--no-open'], {
  stdio: ['ignore', 'pipe', 'pipe'],
  cwd: '/src',
  env: { ...process.env, FIXTURE_MODE: process.env.FIXTURE_MODE ?? 'happy' },
})

daemon.stdout.on('data', (d) => process.stderr.write(`daemon: ${d}`))
daemon.stderr.on('data', (d) => process.stderr.write(`daemon: ${d}`))
daemon.on('close', (code) => {
  fixture.close()
  process.exit(code ?? 0)
})

process.on('SIGTERM', () => { daemon.kill('SIGTERM'); fixture.close() })
