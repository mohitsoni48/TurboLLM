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
import { connect, createServer, type AddressInfo, type Socket } from 'node:net'
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
  /** Opens a connection to the bound port upgraded the way a Code terminal's WebSocket is:
   *  closeAllConnections() leaves it, so the listener's close() waits for it. */
  holdUpgrade(): Promise<void>
  stop(): Promise<void>
}

function bootDaemon(config: Config, args: string[]): Daemon {
  const logs: string[] = []
  const exits: number[] = []
  const upgraded: Socket[] = []
  const timers: NodeJS.Timeout[] = []
  const servers: Server[] = []
  const clients: Socket[] = []
  const deps: Daemon['deps'] = {}
  const scope: Record<string, unknown> = {
    serve: (...a: Parameters<typeof serve>) => {
      const s = serve(...a) as Server
      servers.push(s)
      return s
    },
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
    // Stands in for the terminal WebSocket handler: answers the upgrade and holds the socket.
    registerTerminalWs: (s: Server) => s.on('upgrade', (_req, socket: Socket) => {
      upgraded.push(socket)
      socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: test\r\n\r\n')
    }),
    writePidfile: () => {},
    releaseDataDirClaim: () => {},
    dropStaleTerminalSockets: () => {},
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
    async holdUpgrade() {
      const held = upgraded.length
      const client = connect((server().address() as AddressInfo).port, '127.0.0.1')
      client.on('error', () => {})
      clients.push(client)
      client.write('GET /api/v1/code/terminal/ws HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n')
      await until('the upgraded connection is held', () => upgraded.length > held)
    },
    async stop() {
      for (const t of timers) clearTimeout(t)
      for (const s of [...upgraded, ...clients]) s.destroy()
      // Every listener, not only `server`: without the one-rebind-at-a-time fix it can be a dead
      // instance while another one still listens.
      for (const s of servers) {
        s.closeAllConnections?.()
        if (s.listening) await new Promise((r) => s.close(r))
      }
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

// What the slowest failure takes to show: the 3 s drain fallback, then 20 bind retries 500 ms apart.
const SETTLE_MS = (3_000 + 20 * 500) / SPEEDUP + 200

test('a second rebind while the first one\'s old listener drains re-points it instead of binding twice and exiting', async () => {
  const [p] = await freePorts(1)
  const d = bootDaemon(config({ port: p }), [])
  try {
    await until('the boot listener is up', () => listening(d) === 1)
    await d.holdUpgrade() // an open Code terminal: the old listener's close() waits for the fallback

    d.config.daemon.lanBind = true
    d.deps.rebind!()
    await sleep(500 / SPEEDUP) // well inside the drain window (3 s fallback)
    assert.equal(listening(d), 1, 'still draining')
    // Through the remote-access ingress, which stays up while the main listener drains.
    d.config.daemon.lanBind = false
    d.deps.rebind!()

    await until('the rebind is up', () => listening(d) === 2)
    await sleep(SETTLE_MS)
    assert.deepEqual(d.exits, [], 'the daemon exited')
    assert.equal(listening(d), 2, 'one re-bind, with the config the second rebind asked for')
    assert.equal(boundAt(d), `127.0.0.1:${p}`)
    assert.ok(d.server().listening, '`server` must be the live listener that restart and shutdown close')
    assert.equal(d.logs.filter((l) => l.includes('busy')).length, 0, 'the second bind retried against our own listener')
    const res = await fetch(`http://127.0.0.1:${p}/`)
    assert.equal(await res.text(), 'ok')
  } finally {
    await d.stop()
  }
})

test('a rebind while the previous one retries a busy port moves that bind instead of starting another', async () => {
  const [p, q, r] = await freePorts(3)
  const blocker = createServer()
  await new Promise<void>((res) => blocker.listen(q, '127.0.0.1', res))
  const d = bootDaemon(config({ port: p }), [])
  try {
    await until('the boot listener is up', () => listening(d) === 1)

    d.config.daemon.port = q
    d.deps.rebind!()
    await until(`the bind to the busy ${q} retries`, () => d.logs.some((l) => l.includes(`Port ${q} busy`)))
    d.config.daemon.port = r
    d.deps.rebind!()

    await until('the rebind is up', () => listening(d) === 2)
    await sleep(SETTLE_MS)
    assert.deepEqual(d.exits, [], 'the daemon exited')
    assert.equal(listening(d), 2)
    assert.equal(boundAt(d), `127.0.0.1:${r}`)
    assert.equal(d.deps.bindPort, r)
  } finally {
    await d.stop()
    await new Promise((res) => blocker.close(res))
  }
})

test('a rebind that re-points a bind retrying a busy port gives the new port retries of its own', async () => {
  const [p, q, r] = await freePorts(3)
  const blockers = [createServer(), createServer()]
  await Promise.all([q, r].map((port, i) => new Promise<void>((res) => blockers[i].listen(port, '127.0.0.1', res))))
  const d = bootDaemon(config({ port: p }), [])
  try {
    await until('the boot listener is up', () => listening(d) === 1)

    d.config.daemon.port = q
    d.deps.rebind!()
    await until(`the bind to the busy ${q} retries`, () => d.logs.some((l) => l.includes(`Port ${q} busy`)))
    d.config.daemon.port = r
    d.deps.rebind!()
    // Only the first try of a count says so: r's count starts over instead of getting what q left.
    await until(`the bind to the busy ${r} retries`, () => d.logs.some((l) => l.includes(`Port ${r} busy`)))
    await new Promise((res) => blockers[1].close(res))

    await until('the rebind is up', () => listening(d) === 2)
    await sleep(SETTLE_MS)
    assert.deepEqual(d.exits, [], 'the daemon exited')
    assert.equal(listening(d), 2)
    assert.equal(boundAt(d), `127.0.0.1:${r}`)
  } finally {
    await d.stop()
    for (const b of blockers) if (b.listening) await new Promise((res) => b.close(res))
  }
})
