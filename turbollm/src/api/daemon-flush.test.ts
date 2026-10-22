// POST /api/v1/daemon/flush: the Android app calls it before its Quit kills the process and before its service stops,
// so the chat database sql.js holds in memory is on disk first. Driven through the REAL createApp, because what matters
// is that its gate is /daemon/restart's, and that the file is on disk by the time it answers.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { join } from 'node:path'
import { createApp } from '../server'
import { hashKey, provisionRemoteApiKey } from '../auth'
import { defaultConfig, type Config } from '../config/config'
import { ConversationStore } from '../chat/db'
import { openSqlJsDatabaseSync, preload } from '../chat/store/sql-js-database'
import type { Deps } from '../deps'
import { tmpDir } from '../test-support/tmp'

const INGRESS_PORT = 6997
const RAW_KEY = 'tllm-daemonflushdaemonflushdaemonflush1'

function mkDeps(db: Pick<ConversationStore, 'flush'>, mutate: (cfg: Config) => void = () => {}): { d: Deps; cfg: Config } {
  const cfg = defaultConfig()
  cfg.apiKeys.push({ id: 'k1', name: 'mine', hash: hashKey(RAW_KEY), prefix: RAW_KEY.slice(0, 12), createdAt: '', lastUsedAt: null })
  mutate(cfg)
  const dir = tmpDir('daemon-flush-')
  const d = {
    version: 'test',
    store: { snapshot: () => cfg, update: (fn: (c: Config) => void) => fn(cfg), dir: () => dir },
    // createApp's other routes read the store at registration; only flush matters here.
    db: new Proxy(db, { get: (target, key) => (key in target ? Reflect.get(target, key) : () => []) }),
    telemetry: { firstUse: () => {}, useFeature: () => {} },
    manager: { status: () => ({ state: 'stopped', model: null }), currentOpts: () => null },
    registry: { list: () => ({ engines: [] }), active: () => undefined, customSources: () => [] },
    remote: {
      ingressPort: () => INGRESS_PORT,
      activeProvider: () => cfg.remoteAccess.provider,
      url: () => 'https://box.example.com',
      state: () => ({ kind: 'connected' }),
    },
    // Scheduled 200 ms past the restart route's answer (unref'd): a no-op here.
    requestRestart: () => {},
  } as unknown as Deps
  return { d, cfg }
}

type Caller = (d: Deps, path: string, headers?: Record<string, string>) => Response | Promise<Response>

/** The owner on the machine itself (the Android app's own WebView and EngineService reach it the same way). */
const local: Caller = (d, path, headers = {}) => createApp(d).request(path, { method: 'POST', headers }, {
  incoming: { socket: { localPort: 6996, remoteAddress: '127.0.0.1', remotePort: 55555, remoteFamily: 'IPv4' } },
} as never)
/** Another machine on the LAN. */
const lan: Caller = (d, path, headers = {}) => createApp(d).request(path, { method: 'POST', headers: { Host: '192.168.1.20:6996', ...headers } }, {
  incoming: { socket: { localPort: 6996, remoteAddress: '192.168.1.50', remotePort: 55555, remoteFamily: 'IPv4' } },
} as never)
/** A request on the remote-access ingress socket. */
const tunneled: Caller = (d, path, headers = {}) => createApp(d).request(path, { method: 'POST', headers: { Host: 'box.example.com', ...headers } }, {
  incoming: { socket: { localPort: INGRESS_PORT, remoteAddress: '127.0.0.1', remotePort: 55555, remoteFamily: 'IPv4' } },
} as never)

const reached = (status: number) => status < 400 || status >= 500

test('POST /api/v1/daemon/flush has the gate of /api/v1/daemon/restart, for every kind of caller', async () => {
  const nothingToDo = { flush: () => null }
  const cases: Array<{ what: string; caller: Caller; headers?: (d: Deps) => Record<string, string>; mutate?: (c: Config) => void; expectReached: boolean }> = [
    { what: 'the owner, on the machine', caller: local, expectReached: true },
    { what: 'a LAN caller with no key', caller: lan, mutate: (c) => { c.daemon.lanBind = true }, expectReached: false },
    { what: 'an open-LAN caller with no key', caller: lan, mutate: (c) => { c.daemon.lanBind = true; c.daemon.requireApiKey = false }, expectReached: true },
    { what: 'a LAN caller with a key', caller: lan, headers: () => ({ 'X-TurboLLM-Auth': RAW_KEY }), mutate: (c) => { c.daemon.lanBind = true }, expectReached: true },
    {
      what: 'a remote-access token, whatever it may otherwise do',
      caller: tunneled,
      headers: (d) => ({ 'X-TurboLLM-Auth': provisionRemoteApiKey(d, { kind: 'remote', capabilities: ['models:use', 'models:load', 'config:read', 'config:write', 'downloads:write'] }) }),
      mutate: (c) => { c.remoteAccess.provider = 'cloudflare-quick' },
      expectReached: false,
    },
  ]
  for (const { what, caller, headers, mutate, expectReached } of cases) {
    const { d } = mkDeps(nothingToDo, mutate)
    const h = headers?.(d)
    const restart = await caller(d, '/api/v1/daemon/restart', h)
    const flush = await caller(d, '/api/v1/daemon/flush', h)
    assert.equal(reached(restart.status), expectReached, `${what}: restart ${restart.status}`)
    assert.equal(reached(flush.status), expectReached, `${what}: flush ${flush.status}, restart ${restart.status}`)
    if (expectReached) assert.equal(flush.status, 200, what)
    else assert.equal(flush.status, restart.status, `${what}: refused alike`)
  }
})

test('on node:sqlite (desktop) there is nothing to write: ok, flushed false', async () => {
  const dir = tmpDir('daemon-flush-desktop-')
  const store = new ConversationStore(dir)
  try {
    const { d } = mkDeps(store)
    const res = await local(d, '/api/v1/daemon/flush')
    assert.equal(res.status, 200)
    assert.deepEqual(await res.json(), { ok: true, flushed: false })
  } finally {
    store.close()
  }
})

test('on sql.js (Android) it answers once the database is on disk, and says so when the write failed', async () => {
  await preload()
  const path = join(tmpDir('daemon-flush-android-'), 'turbollm.db')
  const sqljs = openSqlJsDatabaseSync(path)
  try {
    sqljs.exec('CREATE TABLE t (v TEXT)')
    sqljs.prepare('INSERT INTO t (v) VALUES (?)').run('a reply that finished a moment before Quit')
    // The adapter's own flush is a second away; the route writes it now.
    const { d } = mkDeps({ flush: () => sqljs.flush!() })
    const res = await local(d, '/api/v1/daemon/flush')
    assert.equal(res.status, 200)
    assert.deepEqual(await res.json(), { ok: true })
    const copy = openSqlJsDatabaseSync(path)
    assert.deepEqual(copy.prepare('SELECT v FROM t').all(), [{ v: 'a reply that finished a moment before Quit' }], 'on disk when it answered')
    copy.close()

    const failing = mkDeps({ flush: () => false })
    const refused = await local(failing.d, '/api/v1/daemon/flush')
    assert.equal(refused.status, 500)
    assert.equal(((await refused.json()) as { error: { code: string } }).error.code, 'flush_failed')
  } finally {
    sqljs.close()
  }
})
