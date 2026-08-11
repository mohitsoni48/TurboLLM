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
//
// Default bind is loopback-only (the container's own default config, since
// there is nothing seeding daemon.lanBind=true the way the distribution
// Dockerfiles do) — correct for the automated Playwright suite, which runs
// INSIDE this same container and never crosses the Docker NAT boundary.
// Set TURBOLLM_LAN_BIND=1 to additionally pass --addr 0.0.0.0:6996 for a
// manual `docker run -p 6996:6996 ...` session: Docker's port forwarding
// cannot deliver host-side connections to a loopback-bound listener, so a
// bare loopback bind here otherwise accepts the TCP handshake at the
// docker-proxy layer and then silently hangs/empty-replies past it. Still
// port 6996 either way — this widens the bind interface, not the port.
const { spawn } = await import('node:child_process')
const daemonArgs = ['dist/cli.js', '--no-open']
if (process.env.TURBOLLM_LAN_BIND === '1') daemonArgs.push('--addr', '0.0.0.0:6996')
const daemon = spawn('node', daemonArgs, {
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
