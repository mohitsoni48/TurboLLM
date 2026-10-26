// The SSE streams a client holds open (the engine log and the request log under Engines >
// Monitor and Requests, and a Code session's run stream), through the REAL createApp: lanAuth,
// then codeAuth on /api/v1/code/*. Both judge a request once, when it arrives, and a stream then
// ran until its client went away. So after the owner deleted a key (or Connect replaced it), a LAN
// client that had opened a stream with it kept getting every new log line, request and Code tool
// output while each new request with the key got 401; and a keyless peer on an open LAN kept its
// streams after "Require an API key" was turned on. A Code terminal is dropped in both cases
// (dropStaleTerminalSockets); these now end too (auth.ts endStaleStreams).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { appendFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Hono } from 'hono'
import { createApp } from './server'
import { hashKey } from './auth'
import { registerCodeRoutes } from './code/code-routes'
import { RingBuffer, subscribeToBuffer, type CodeRunManager } from './code/code-run-manager'
import { RequestLog } from './observability/request-log'
import { defaultConfig, type Config } from './config/config'
import type { Deps } from './deps'
import { tmpDir } from './test-support/tmp'

const RAW_A = 'tllm-heldstreamsheldstreamsheldstreamsa1'
const RAW_B = 'tllm-heldstreamsheldstreamsheldstreamsb2'

type Socket = { localPort: number; remoteAddress: string }
const LAN: Socket = { localPort: 6996, remoteAddress: '192.168.1.50' }
const LOOPBACK: Socket = { localPort: 6996, remoteAddress: '127.0.0.1' }

/** A LAN-exposed daemon (lanBind on) with keys A and B, an engine log and a request log, and a
 *  Code session 's1' whose run stream the test feeds through `emitCode`. */
function harness(mutate: (cfg: Config) => void = () => {}) {
  const cfg = defaultConfig()
  cfg.daemon.lanBind = true
  cfg.apiKeys.push(
    { id: 'kA', name: 'a', hash: hashKey(RAW_A), prefix: RAW_A.slice(0, 12), createdAt: '', lastUsedAt: null },
    { id: 'kB', name: 'b', hash: hashKey(RAW_B), prefix: RAW_B.slice(0, 12), createdAt: '', lastUsedAt: null },
  )
  mutate(cfg)
  const dir = tmpDir('held-streams-')
  const logPath = join(dir, 'engine.log')
  writeFileSync(logPath, '')
  const requestLog = new RequestLog()
  const d = {
    version: 'test',
    // A copy per snapshot, as ConfigStore's: PATCH /settings compares the one before its update.
    store: { snapshot: () => structuredClone(cfg), update: (fn: (c: Config) => void) => fn(cfg), dir: () => dir },
    db: new Proxy({}, { get: (_t, p) => (p === 'getAgentRun' ? () => ({ id: 's1' }) : () => []) }),
    telemetry: { firstUse: () => {}, useFeature: () => {} },
    manager: { status: () => ({ state: 'stopped', model: null }), logPath: () => logPath },
    requestLog,
  } as unknown as Deps
  // A Code session whose turn is still running: each subscriber live-tails the same emitter.
  const buffer = new RingBuffer()
  const emitter = new EventEmitter()
  const runs = {
    reconcileOnStartup: () => {},
    subscribe: () => subscribeToBuffer(buffer, emitter, { fromSeq: buffer.head(), replayFloor: 0, idleAtStart: false }),
    activeMeta: () => null,
    queued: () => [],
    todos: () => [],
  } as unknown as CodeRunManager
  const app: Hono = createApp(d)
  registerCodeRoutes(app, d, runs)
  const send = (socket: Socket, method: string, path: string, opts: { key?: string; body?: unknown; headers?: Record<string, string> } = {}) =>
    app.request(path, {
      method,
      headers: {
        ...(opts.key ? { Authorization: `Bearer ${opts.key}` } : {}),
        ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...opts.headers,
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    }, { incoming: { socket: { ...socket, remotePort: 55555, remoteFamily: 'IPv4' } } } as never)
  let n = 0
  return {
    cfg,
    send,
    /** Something new on each stream: an engine-log line, a request-log entry and a Code frame. */
    emit(tag: string) {
      appendFileSync(logPath, `${tag}\n`)
      requestLog.start({
        source: 'openai', harness: null, codeSessionId: null, modelKey: tag, remote: null, stream: false,
        params: {}, counts: { messages: 1, tools: 0, systemChars: 0 },
      })
      emitter.emit('event', buffer.push('tool_output', { n: n++, output: tag }))
    },
  }
}

const STREAMS = [
  { name: 'an engine log', path: '/api/v1/engine/logs/stream', event: 'line' },
  { name: 'a request log', path: '/api/v1/requests/stream', event: 'entry' },
  { name: 'a Code session', path: '/api/v1/code/sessions/s1/stream', event: 'tool_output' },
] as const

/** Reads one SSE stream: `next(tag)` waits for the frame carrying `tag`, skipping the others, and
 *  answers 'ended' once the daemon has closed the stream. */
function reader(res: Response) {
  const r = res.body!.getReader()
  const dec = new TextDecoder()
  let buf = ''
  let ended = false
  return {
    async next(event: string, tag: string, timeoutMs = 3000): Promise<'seen' | 'ended'> {
      const deadline = Date.now() + timeoutMs
      while (true) {
        for (let end = buf.indexOf('\n\n'); end !== -1; end = buf.indexOf('\n\n')) {
          const frame = buf.slice(0, end)
          buf = buf.slice(end + 2)
          if (frame.includes(`event: ${event}`) && frame.includes(tag)) return 'seen'
        }
        if (ended) return 'ended'
        const left = deadline - Date.now()
        if (left <= 0) throw new Error(`no ${event} frame with ${tag} within ${timeoutMs} ms, and the stream is still open`)
        const timer = new Promise<'timeout'>((res) => setTimeout(() => res('timeout'), left).unref())
        const got = await Promise.race([r.read(), timer])
        if (got === 'timeout') continue
        if (got.done) ended = true
        else buf += dec.decode(got.value, { stream: true })
      }
    },
    close: () => r.cancel().catch(() => {}),
  }
}

/** Opens a stream and waits until it is live (it has sent the frame for `warm`). */
async function open(h: ReturnType<typeof harness>, s: (typeof STREAMS)[number], socket: Socket, key: string | undefined, warm: string) {
  const res = await h.send(socket, 'GET', s.path, { key })
  assert.equal(res.status, 200, `${s.name}: opened`)
  const rd = reader(res)
  // The engine-log loop starts at the log's current end and polls every 400 ms: give it a tick.
  await new Promise((r) => setTimeout(r, 500))
  h.emit(warm)
  assert.equal(await rd.next(s.event, warm), 'seen', `${s.name}: live before the change`)
  return rd
}

for (const s of STREAMS) {
  test(`${s.name} stream opened with a key ends once the key is deleted; one on another key and the host's own stay`, async () => {
    const h = harness()
    const withA = await open(h, s, LAN, RAW_A, 'warm-a')
    const withB = await open(h, s, LAN, RAW_B, 'warm-b')
    // The host's own stream: loopback trust let it in, not the key it also sent.
    const host = await open(h, s, LOOPBACK, RAW_A, 'warm-host')
    try {
      const del = await h.send(LOOPBACK, 'DELETE', '/api/v1/keys/kA')
      assert.equal(del.status, 200)
      assert.equal((await h.send(LAN, 'GET', s.path.replace(/\/stream$/, ''), { key: RAW_A })).status, 401, 'a new request with the key is refused')
      h.emit('after-revoke')
      assert.equal(await withA.next(s.event, 'after-revoke'), 'ended', `${s.name}: the stream opened with the deleted key ends`)
      assert.equal(await withB.next(s.event, 'after-revoke'), 'seen', `${s.name}: key B's stream stays`)
      assert.equal(await host.next(s.event, 'after-revoke'), 'seen', `${s.name}: the host's stream stays`)
    } finally {
      await Promise.all([withA.close(), withB.close(), host.close()])
    }
  })
}

test('a stream opened with the key Connect replaces ends when Connect mints its new one', async () => {
  const h = harness((cfg) => { cfg.apiKeys[0].name = 'cli-claude' })
  const s = STREAMS[1]
  const withA = await open(h, s, LAN, RAW_A, 'warm-a')
  try {
    const res = await h.send(LOOPBACK, 'GET', '/api/v1/connect/claude', { headers: { 'X-TurboLLM-UI': '1' } })
    assert.equal(res.status, 200)
    h.emit('after-remint')
    assert.equal(await withA.next(s.event, 'after-remint'), 'ended')
  } finally {
    await withA.close()
  }
})

for (const s of STREAMS) {
  test(`turning "Require an API key" on ends a keyless open-LAN peer's stream of ${s.name}; a keyed one stays`, async () => {
    const h = harness((cfg) => { cfg.daemon.requireApiKey = false })
    // Code needs a key from another machine whatever requireApiKey says (codeAuth): no keyless one.
    const keyless = s.path.startsWith('/api/v1/code/') ? undefined : await open(h, s, LAN, undefined, 'warm-open')
    if (!keyless) assert.equal((await h.send(LAN, 'GET', s.path)).status, 401)
    const keyed = await open(h, s, LAN, RAW_B, 'warm-b')
    try {
      const res = await h.send(LOOPBACK, 'PATCH', '/api/v1/settings', { body: { requireApiKey: true } })
      assert.equal(res.status, 200)
      assert.equal(h.cfg.daemon.requireApiKey, true)
      h.emit('after-require')
      if (keyless) assert.equal(await keyless.next(s.event, 'after-require'), 'ended', `${s.name}: the keyless stream ends`)
      assert.equal(await keyed.next(s.event, 'after-require'), 'seen', `${s.name}: the keyed stream stays`)
    } finally {
      await Promise.all([keyless?.close(), keyed.close()])
    }
  })
}

test('an open-LAN peer that also sent a valid key keeps its stream when "Require an API key" is turned on', async () => {
  const h = harness((cfg) => { cfg.daemon.requireApiKey = false })
  const s = STREAMS[1]
  const peer = await open(h, s, LAN, RAW_A, 'warm-a')
  try {
    assert.equal((await h.send(LOOPBACK, 'PATCH', '/api/v1/settings', { body: { requireApiKey: true } })).status, 200)
    h.emit('after-require')
    assert.equal(await peer.next(s.event, 'after-require'), 'seen')
    // Its key is what lets it in now: deleting it ends the stream.
    assert.equal((await h.send(LOOPBACK, 'DELETE', '/api/v1/keys/kA')).status, 200)
    h.emit('after-revoke')
    assert.equal(await peer.next(s.event, 'after-revoke'), 'ended')
  } finally {
    await peer.close()
  }
})
