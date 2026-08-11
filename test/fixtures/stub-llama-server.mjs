#!/usr/bin/env node
// Stands in for a real llama-server engine binary inside the CPU-only Playwright
// harness. Registered through the real, shipped "point at your own engine
// binary" API (POST /api/v1/engines -> engines/registry.ts's add()) from the
// E2E suite itself — nothing about production auto-provisioning (ADR-024)
// changes to get a working engine inside this container.
//
// engines/probe.ts's probe() execFiles this directly with --version and
// --help and expects a version line plus a prompt exit — answer both
// immediately, no matter what other args are also present. A real launch
// (no matching flag — llama.cpp's own `-m <path> --host <ip> --port <N>`)
// opens an HTTP server and answers /health with 200 the moment it starts;
// manager.ts's readiness() polls exactly that endpoint before Status.model
// is populated. This does NOT emulate chat completions — nothing in the
// onboarding E2E suite waits on a real generated token: Payoff only needs
// createConversation()/createCodeSession() to succeed, which never touches
// the engine, and auto-tune's own sweep is expected to fail past the first
// candidate once it tries to actually measure tokens/sec — the onboarding
// tests only assert that starting it produces a REAL state transition
// (fixing the silent-409 bug), not that a full sweep completes.
import { createServer } from 'node:http'

const args = process.argv.slice(2)
if (args.includes('--version') || args.includes('--help')) {
  process.stdout.write('version: 9999 (stub-e2e)\nusage: stub-llama-server [options]\n--host, --port, -m\n')
  process.exit(0)
}

const portIdx = args.indexOf('--port')
const port = portIdx >= 0 ? Number(args[portIdx + 1]) : 8081
const hostIdx = args.indexOf('--host')
const host = hostIdx >= 0 ? args[hostIdx + 1] : '127.0.0.1'

createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' }).end('{"status":"ok"}')
    return
  }
  res.writeHead(200, { 'content-type': 'application/json' }).end('{}')
}).listen(port, host, () => {
  process.stdout.write(`main: server is listening on ${host}:${port}\n`)
})
