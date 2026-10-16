// Behaviour tests for the daemon's in-place LAN/port rebind (cli.ts: the listen address, listen()
// and deps.rebind).
//
// cli.ts is top-level module code: importing it boots the real daemon (see
// cli.lifecycle-wiring.test.ts), so these run cli.ts's own text instead. The source from
// "Resolve listen address" through the end of `deps.rebind = () => {…}` is cut out, its types are
// stripped by esbuild, and it runs with the real @hono/node-server `serve` on real sockets. The
// daemon pieces it names (config store, deps, argv, pidfile, banner inputs) are stand-ins, its
// own timers run SPEEDUP times faster, and process.exit is recorded instead of called.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { createServer, type AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { transformSync } from 'esbuild'
import { serve } from '@hono/node-server'

const HERE = dirname(fileURLToPath(import.meta.url))
const CLI = readFileSync(join(HERE, 'cli.ts'), 'utf8').replace(/\r\n/g, '\n')
const SPEEDUP = 20

/** cli.ts from the listen address through deps.rebind, as JavaScript. */
const SOURCE = (() => {
  const start = CLI.indexOf('// ── Resolve listen address')
  const rebind = CLI.indexOf('deps.rebind = () => {', start)
  assert.ok(start >= 0 && rebind > start, 'cli.ts must resolve the listen address, then define deps.rebind')
  const end = CLI.indexOf('\n}\n', rebind)
  assert.ok(end > rebind, 'no column-0 closing brace after deps.rebind')
  return transformSync(CLI.slice(start, end + 2), { loader: 'ts' }).code
})()

interface Config {
  daemon: { lanBind: boolean; host: string; port: number; openBrowserOnStart: boolean }
  remoteAccess: { enabled: boolean }
}

interface Daemon {
  /** What store.snapshot() returns; change it, then call deps.rebind() as the settings route does. */
  config: Config
  deps: { rebind?: () => void; bindHost?: string; bindPort?: number }
  logs: string[]
  exits: number[]
  /** The listener cli.ts's `server` points at. */
  server(): Server
  stop(): Promise<void>
}

function bootDaemon(config: Config, args: string[]): Daemon {
  const logs: string[] = []
  const exits: number[] = []
  const timers: NodeJS.Timeout[] = []
  const deps: Daemon['deps'] = {}
  const scope: Record<string, unknown> = {
    serve,
    app: { fetch: () => new Response('ok') },
    deps,
    store: { snapshot: () => structuredClone(config), dir: () => '' },
    argValue: (name: string, fallback: string) => {
      const i = args.indexOf(name)
      return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback
    },
    hasFlag: (...names: string[]) => names.some((n) => args.includes(n)),
    provisionBootstrapApiKey: () => null,
    getAdvertisedHost: () => null,
    spawn: () => { throw new Error('no browser in a test') },
    version: 'test',
    provisionTunnelApiKey: () => { throw new Error('no key in a test') },
    remoteWanted: false,
    tunnelFlag: false,
    remote: {},
    reconcileTailscalePromise: Promise.resolve(),
    registerTerminalWs: () => {}, // no Code terminal here
    writePidfile: () => {},
    releaseDataDirClaim: () => {},
    console: {
      log: (...a: unknown[]) => logs.push(a.join(' ')),
      warn: (...a: unknown[]) => logs.push(a.join(' ')),
      error: (...a: unknown[]) => logs.push(`ERR ${a.join(' ')}`),
    },
    process: {
      env: {},
      platform: process.platform,
      pid: process.pid,
      stdout: { write: (text: string) => logs.push(text.trimEnd()) },
      exit: (code: number) => { exits.push(code) },
    },
    setTimeout: (fn: () => void, ms: number) => {
      const t = setTimeout(fn, ms / SPEEDUP)
      timers.push(t)
      return t
    },
  }
  const names = Object.keys(scope)
  const run = new Function(...names, `${SOURCE}\nreturn () => server`) as (...v: unknown[]) => () => Server
  const server = run(...names.map((n) => scope[n]))
  return {
    config, deps, logs, exits, server,
    async stop() {
      for (const t of timers) clearTimeout(t)
      const live = server()
      live.closeAllConnections?.()
      if (live.listening) await new Promise((r) => live.close(r))
    },
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function until(what: string, ok: () => boolean, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms
  while (!ok()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting until ${what}`)
    await sleep(10)
  }
}

/** n free ports, all held until each is known, so no two are the same. */
async function freePorts(n: number): Promise<number[]> {
  const held: ReturnType<typeof createServer>[] = []
  for (let i = 0; i < n; i++) {
    const s = createServer()
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', r))
    held.push(s)
  }
  const ports = held.map((s) => (s.address() as AddressInfo).port)
  await Promise.all(held.map((s) => new Promise((r) => s.close(r))))
  return ports
}

function config(daemon: Partial<Config['daemon']>): Config {
  return { daemon: { lanBind: false, host: '127.0.0.1', port: 6996, openBrowserOnStart: false, ...daemon }, remoteAccess: { enabled: false } }
}

const listening = (d: Daemon) => d.logs.filter((l) => l.startsWith('TurboLLM test listening on')).length
const boundAt = (d: Daemon) => {
  const a = d.server().address() as AddressInfo
  return `${a.address}:${a.port}`
}

test('a port change keeps the --addr host: 127.0.0.1 under daemon.host 0.0.0.0 stays on loopback', async () => {
  const [p, q] = await freePorts(2)
  const d = bootDaemon(config({ host: '0.0.0.0', port: p }), ['--addr', `127.0.0.1:${p}`])
  try {
    await until('the boot listener is up', () => listening(d) === 1)
    assert.equal(boundAt(d), `127.0.0.1:${p}`)

    d.config.daemon.port = q
    d.deps.rebind!()
    await until('the rebind is up', () => listening(d) === 2)

    assert.equal(boundAt(d), `127.0.0.1:${q}`, 'the rebind moved the port onto every interface')
    assert.equal(d.deps.bindHost, '127.0.0.1')
  } finally {
    await d.stop()
  }
})

test('a port change keeps the --addr host: 0.0.0.0 with lanBind off is not moved to 127.0.0.1', async () => {
  const [p, q] = await freePorts(2)
  const d = bootDaemon(config({ host: '', port: p }), ['--addr', `0.0.0.0:${p}`])
  try {
    await until('the boot listener is up', () => listening(d) === 1)
    assert.equal(boundAt(d), `0.0.0.0:${p}`)

    d.config.daemon.port = q
    d.deps.rebind!()
    await until('the rebind is up', () => listening(d) === 2)

    assert.equal(boundAt(d), `0.0.0.0:${q}`, 'LAN clients lose the daemon at the --addr host')
    assert.equal(d.deps.bindHost, '0.0.0.0')
  } finally {
    await d.stop()
  }
})

test('a LAN toggle still moves an --addr host, and a later port change keeps the new one', async () => {
  const [p, q] = await freePorts(2)
  const d = bootDaemon(config({ host: '', port: p }), ['--addr', `0.0.0.0:${p}`])
  try {
    await until('the boot listener is up', () => listening(d) === 1)

    d.config.daemon.lanBind = true
    d.deps.rebind!()
    // lanBind was off at boot and is on now, but the host it asks for is the one --addr bound.
    await sleep(100)
    assert.equal(listening(d), 1, 'nothing to change: 0.0.0.0 already')

    d.config.daemon.lanBind = false
    d.deps.rebind!()
    await until('the LAN-off rebind is up', () => listening(d) === 2)
    assert.equal(boundAt(d), `127.0.0.1:${p}`, 'turning LAN off moves the host to the configured one')

    d.config.daemon.port = q
    d.deps.rebind!()
    await until('the port rebind is up', () => listening(d) === 3)
    assert.equal(boundAt(d), `127.0.0.1:${q}`)
  } finally {
    await d.stop()
  }
})

test('a LAN toggle moves an --addr host even where daemon.host already asks for 0.0.0.0', async () => {
  const [p, q] = await freePorts(2)
  const d = bootDaemon(config({ host: '0.0.0.0', port: p }), ['--addr', `127.0.0.1:${p}`])
  try {
    await until('the boot listener is up', () => listening(d) === 1)

    // Both lanBind values ask for 0.0.0.0 here; what moves the host is that lanBind changed.
    d.config.daemon.lanBind = true
    d.deps.rebind!()
    await until('the LAN-on rebind is up', () => listening(d) === 2)
    assert.equal(boundAt(d), `0.0.0.0:${p}`, 'LAN shows as on, but the daemon stayed on loopback')
    assert.equal(d.deps.bindHost, '0.0.0.0')

    d.config.daemon.lanBind = false
    d.deps.rebind!()
    await sleep(100)
    assert.equal(listening(d), 2, 'nothing to change: daemon.host asks for 0.0.0.0 too')

    d.config.daemon.port = q
    d.deps.rebind!()
    await until('the port rebind is up', () => listening(d) === 3)
    assert.equal(boundAt(d), `0.0.0.0:${q}`)
  } finally {
    await d.stop()
  }
})
