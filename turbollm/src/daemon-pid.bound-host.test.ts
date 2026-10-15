// The one-daemon-per-data-dir guard (cli.ts → findRunningDaemon) against a daemon bound to ONE
// non-loopback interface (`--addr 192.168.1.5:…`, `daemon.host`), over a real socket and the real
// app (createApp: Server header, lanAuth, /healthz). Such a daemon never answers on 127.0.0.1,
// and being LAN-exposed with requireApiKey (the default) it answers /api/v1/status 401 to a
// keyless caller that is not loopback — which this probe, aimed at the machine's own LAN
// address, is not. The guard used to probe 127.0.0.1's /api/v1/status, missed it, and a second
// start ran every boot side effect and kept running beside it on the same data dir.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import os, { networkInterfaces } from 'node:os'
import http from 'node:http'
import { syncBuiltinESMExports } from 'node:module'
import { rmSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { serve } from '@hono/node-server'
import { createApp } from './server'
import { defaultConfig } from './config/config'
import type { Deps } from './deps'
import { findRunningDaemon, stopDaemon, writePidfile } from './daemon-pid'
import { tmpDir } from './test-support/tmp'

/** This machine's first non-internal IPv4 address, or undefined (no network: the test skips). */
function lanAddress(): string | undefined {
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) if (a.family === 'IPv4' && !a.internal) return a.address
  }
  return undefined
}

function mkDeps(bindHost: string): Deps {
  // Same minimal double as server.route-order.test.ts: createApp only needs these to register.
  const db = new Proxy({}, { get: () => () => [] })
  const cfg = defaultConfig() // requireApiKey: true, lanBind: false — a plain `--addr <ip>:<port>`
  return {
    version: 'test',
    store: { snapshot: () => cfg, update: (fn: (c: never) => void) => fn(cfg as never), dir: () => '.' },
    db,
    telemetry: { firstUse: () => {}, useFeature: () => {} },
    bindHost,
  } as unknown as Deps
}

const lan = lanAddress()
// Listening on a LAN address makes Windows (and macOS with its firewall on) ask the developer
// running the suite whether to allow node through; CI runs the daemon tests on Linux.
const skip = process.platform === 'win32' || process.platform === 'darwin'
  ? 'binding a LAN address raises a firewall prompt on this OS'
  : !lan && 'no non-loopback IPv4 interface'

test('findRunningDaemon finds a daemon bound to a specific non-loopback address', { skip }, async (t) => {
  const host = lan as string
  const server = await new Promise<ReturnType<typeof serve>>((resolve, reject) => {
    const s = serve({ fetch: createApp(mkDeps(host)).fetch, hostname: host, port: 0 }, () => resolve(s))
    ;(s as unknown as { once: (ev: 'error', cb: (e: Error) => void) => void }).once('error', reject)
  })
  const dir = tmpDir('turbollm-pid-bound-')
  try {
    const port = (server.address() as { port: number }).port
    // Why probing the right address is not enough on its own: /api/v1/status refuses this caller.
    assert.equal((await fetch(`http://${host}:${port}/api/v1/status`, { signal: AbortSignal.timeout(2000) })).status, 401)

    // What cli.ts writes on bind: this process's pid (alive), the port, the bound address.
    writePidfile(dir, process.pid, port, host)
    // selfPid 0: we are the "second start", not the daemon that owns the pidfile.
    assert.deepEqual(await findRunningDaemon(dir, undefined, 0), { pid: process.pid, port, host })

    // The OS interface list is no proof either way: libuv leaves out an interface that is up but
    // has no carrier (docker0 or virbr0 with nothing attached), and a daemon bound to its address
    // still answers. Hide the address from the list; the daemon must still be found.
    const listing = t.mock.method(os, 'networkInterfaces', () => ({}))
    syncBuiltinESMExports()
    try {
      assert.deepEqual(await findRunningDaemon(dir, undefined, 0), { pid: process.pid, port, host }, 'an unlisted local address')
    } finally {
      listing.mock.restore()
      syncBuiltinESMExports()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
    await new Promise<void>((r) => server.close(() => r()))
  }
})

// The other side of probing the recorded address: it must be an address of THIS machine. A
// pidfile left by an unclean exit can name an address that another machine has since been given
// (a new DHCP lease); if that machine runs TurboLLM it answers /healthz like ours, and --stop
// would then kill whatever unrelated local process got the recorded pid. Stand-in for a network
// where every address answers as a TurboLLM: a local server that every probe is redirected to,
// whichever HTTP client makes it (`fetch` is answered directly; `http.get` keeps its options,
// including the local address it binds, and only its destination is changed).
test('the identity probe never counts an answer from an address this machine does not have', async (t) => {
  const reached: string[] = []
  const standIn = http.createServer((req, res) => {
    reached.push(String(req.socket.localAddress))
    res.writeHead(200, { server: 'TurboLLM/9.9.9', 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, version: '9.9.9' }))
  })
  await new Promise<void>((r) => standIn.listen(0, '127.0.0.1', () => r()))
  const standInPort = (standIn.address() as { port: number }).port
  const realGet = http.get
  const get = t.mock.method(http, 'get', ((opts: http.RequestOptions, cb?: (res: http.IncomingMessage) => void) =>
    realGet({ ...opts, host: '127.0.0.1', port: standInPort }, cb)) as unknown as typeof http.get)
  syncBuiltinESMExports()
  t.after(() => {
    get.mock.restore()
    syncBuiltinESMExports()
  })
  t.mock.method(globalThis, 'fetch', (async (url: string | URL | Request) => {
    reached.push(`fetch ${String(url)}`)
    return new Response(JSON.stringify({ ok: true, version: '9.9.9' }), {
      headers: { server: 'TurboLLM/9.9.9', 'content-type': 'application/json' },
    })
  }) as typeof fetch)
  // An unrelated local process holding the recorded pid.
  const other = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' })
  const dir = tmpDir('turbollm-pid-foreign-')
  try {
    // Control: the stand-in's answer is accepted for a local address.
    writePidfile(dir, process.pid, 6996, '127.0.0.1')
    assert.deepEqual(await findRunningDaemon(dir, undefined, 0), { pid: process.pid, port: 6996, host: '127.0.0.1' })
    assert.equal(reached.length, 1, 'the control probe reached the stand-in')
    reached.length = 0

    // 203.0.113.7 (TEST-NET-3) is not an address of this machine.
    writePidfile(dir, process.pid, 6996, '203.0.113.7')
    const t0 = Date.now()
    assert.equal(await findRunningDaemon(dir, undefined, 0), null, 'start guard: not proof')
    assert.ok(Date.now() - t0 < 1500, 'refused at once, not after the probe timeout')
    writePidfile(dir, other.pid as number, 6996, '203.0.113.7')
    const res = await stopDaemon(dir)
    assert.equal(res.stopped, false, res.message)
    assert.deepEqual(reached, [], 'no answer was taken from the network')
    assert.equal(other.exitCode ?? other.signalCode, null, 'the unrelated process is still running')
  } finally {
    other.kill('SIGKILL')
    rmSync(dir, { recursive: true, force: true })
    await new Promise<void>((r) => standIn.close(() => r()))
  }
})

// The start guard is awaited at the top level of cli.ts, so the default probe must never throw:
// http.get throws synchronously on a port out of range, which a hand-edited pidfile can hold.
test('the identity probe rejects a junk port instead of throwing', async () => {
  const dir = tmpDir('turbollm-pid-junkport-')
  try {
    for (const port of [99999, -1, 0, 1.5]) {
      writePidfile(dir, process.pid, port, '127.0.0.1')
      assert.equal(await findRunningDaemon(dir, undefined, 0), null, String(port))
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
