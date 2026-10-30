// The text classification playground's run as a daemon job (POST/GET/DELETE /api/v1/jev/playground/run). It posted
// /v1/systemone itself, a gateway route that aborts its engine call when its client goes away, so closing, reloading or
// leaving the screen mid-run threw the run away, and a finished answer lived only in that response. The engine is a real
// node:http stand-in for a Jev model's /classify, so an engine going away really drops the connection, and a cancel
// really closes it; the router is a double that routes to it.
import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { test } from 'node:test'
import { Hono } from 'hono'
import { endLanTurns, endStaleStreams, hashKey, lanAuth, provisionRemoteApiKey } from '../auth'
import { defaultConfig, type Config } from '../config/config'
import { RemoteAccessManager } from '../remote/manager'
import type { PreflightState, RemoteProvider } from '../remote/types'
import type { Deps } from '../deps'
import { handleSystemOne } from '../gateway/systemone-endpoint'
import type { JevInfo } from '../models/jev'
import type { ModelEntry } from '../models/scanner'
import { registerSystemOneJobRoutes, SYSTEMONE_JOB_PATH, type SystemOneJobView } from './systemone-job'

const MODEL_KEY = 'qwen3.5 4b nli v2|mlx-fp16|9012345678'
const JEV: JevInfo = {
  labels: ['contradiction', 'entailment', 'neutral'],
  nliTemplate: 'Premise: {premise}\nHypothesis: {hypothesis}',
  architecture: 'Qwen3_5ForSequenceClassification',
  verified: true,
}
const ENTRY = { key: MODEL_KEY, name: 'qwen3.5 4b nli v2', jev: JEV } as unknown as ModelEntry
const REQUEST = { state: 'My payment keeps failing, please help now.', model: MODEL_KEY, questions: { urgent: { type: 'noul', instructions: 'Is it urgent?' } } }

/** A Jev engine's /classify that holds each call until the test answers it (or drops it), and records how each one
 *  ended: answered, or closed by the caller first. */
async function standInEngine(t: { after: (fn: () => unknown) => void }) {
  const held: Array<{ res: ServerResponse; inputs: number }> = []
  const closedByCaller: number[] = []
  let calls = 0
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = ''
    req.on('data', (chunk: Buffer) => { raw += chunk.toString() })
    req.on('end', () => {
      const call = calls++
      const { input } = JSON.parse(raw) as { input: string[] }
      held.push({ res, inputs: input.length })
      res.on('close', () => { if (!res.writableEnded) closedByCaller.push(call) })
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()) }))
  const until = async (ok: () => boolean) => { for (let i = 0; i < 200 && !ok(); i++) await new Promise((r) => setTimeout(r, 10)) }
  return {
    target: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    calls: () => calls,
    closedByCaller,
    /** Resolves once the n-th call (1-based) is held. */
    called: (n = 1) => until(() => held.length >= n),
    /** Answer the oldest held call: every input entailed with 0.9. */
    answer: () => {
      const { res, inputs } = held.shift()!
      const data = Array.from({ length: inputs }, (_, index) => ({ index, probs: [0.05, 0.9, 0.05] }))
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data, usage: { prompt_tokens: 21, total_tokens: 21 } }))
    },
    /** The engine goes away mid-call, as an engine stop or unload kills its process: every connection drops. */
    stop: () => server.closeAllConnections(),
    until,
  }
}

function deps(target: string, entries: ModelEntry[] = [ENTRY]): Deps {
  return {
    modelRouter: {
      resolveRemoteTarget: () => undefined,
      resolveLocal: (id: string) => entries.find((e) => e.key === id || e.name === id),
      routeTo: async () => ({ target }),
      aliveSlots: () => [],
    },
    scanner: { list: () => ({ models: entries, scanning: false, lastScanAt: '' }) },
  } as unknown as Deps
}

function jobApp(d: Deps): Hono {
  const app = new Hono()
  registerSystemOneJobRoutes(app, d)
  return app
}

const post = (app: Hono, body: unknown, init: RequestInit = {}) =>
  app.request(SYSTEMONE_JOB_PATH, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), ...init })
const view = async (app: Hono): Promise<SystemOneJobView> => (await (await app.request(SYSTEMONE_JOB_PATH)).json()) as SystemOneJobView
/** GET, until the run is no longer running (as the page polls). */
const settled = async (app: Hono): Promise<SystemOneJobView> => {
  let last = await view(app)
  for (let i = 0; i < 200 && last.state === 'running'; i++) {
    await new Promise((r) => setTimeout(r, 10))
    last = await view(app)
  }
  return last
}

test('the run outlives the request that started it, and its answer is readable after', async (t) => {
  const engine = await standInEngine(t)
  const app = jobApp(deps(engine.target))
  assert.deepEqual(await view(app), { state: 'idle' })

  // The page posts, then goes away (closed, reloaded, left): its request is over and its signal fires.
  const page = new AbortController()
  const res = await post(app, REQUEST, { signal: page.signal })
  assert.equal(res.status, 202)
  const started = (await res.json()) as SystemOneJobView
  assert.equal(started.state, 'running')
  assert.ok(started.id)
  assert.deepEqual(started.request, REQUEST)
  page.abort()
  await engine.called()
  await new Promise((r) => setTimeout(r, 50))
  assert.deepEqual(engine.closedByCaller, [], 'the engine call is still open after the page went away')
  assert.equal((await view(app)).state, 'running')

  engine.answer()
  const done = await settled(app)
  assert.equal(done.state, 'done')
  assert.equal(done.id, started.id)
  assert.deepEqual(done.request, REQUEST, 'the request it answered, for the page that comes back')
  assert.equal(done.response?.model, MODEL_KEY)
  assert.deepEqual(done.response?.answers, { urgent: { type: 'noul', noul: 0.9 } })
  assert.deepEqual(done.response?.usage, { input_tokens: 21, output_tokens: 0 })
  assert.ok(done.startedAt && done.finishedAt && Date.parse(done.finishedAt) >= Date.parse(done.startedAt))
  assert.deepEqual(await view(app), done, 'still there for the next page that asks')
})

test('a /v1/systemone client that goes away still aborts its engine call: API clients keep that lifetime', async (t) => {
  const engine = await standInEngine(t)
  const app = new Hono()
  app.post('/v1/systemone', (c) => handleSystemOne(c, deps(engine.target)))
  const client = new AbortController()
  const answered = Promise.resolve(app.request('/v1/systemone', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(REQUEST), signal: client.signal,
  }))
  await engine.called()
  client.abort()
  await engine.until(() => engine.closedByCaller.length > 0)
  assert.deepEqual(engine.closedByCaller, [0])
  assert.equal((await answered).status, 500)
})

test('Cancel ends the run as cancelled and closes the engine call; a late answer cannot overwrite it', async (t) => {
  const engine = await standInEngine(t)
  const app = jobApp(deps(engine.target))
  const { id } = (await (await post(app, REQUEST)).json()) as SystemOneJobView
  await engine.called()

  const res = await app.request(`${SYSTEMONE_JOB_PATH}?id=${id}`, { method: 'DELETE' })
  assert.equal(res.status, 200)
  const cancelled = (await res.json()) as SystemOneJobView
  assert.equal(cancelled.state, 'cancelled')
  assert.equal(cancelled.id, id)
  assert.ok(cancelled.finishedAt)
  await engine.until(() => engine.closedByCaller.length > 0)
  assert.deepEqual(engine.closedByCaller, [0], 'the engine call was aborted')
  await new Promise((r) => setTimeout(r, 50))
  const after = await view(app)
  assert.equal(after.state, 'cancelled')
  assert.equal(after.response, undefined)
  assert.equal(after.error, undefined)
})

test('a Cancel naming another run cancels nothing', async (t) => {
  const engine = await standInEngine(t)
  const app = jobApp(deps(engine.target))
  await post(app, REQUEST)
  await engine.called()

  const res = await app.request(`${SYSTEMONE_JOB_PATH}?id=an-older-run`, { method: 'DELETE' })
  assert.equal(((await res.json()) as SystemOneJobView).state, 'running')
  engine.answer()
  assert.equal((await settled(app)).state, 'done')
  assert.deepEqual(engine.closedByCaller, [])
})

test('the engine going away mid-run (an engine stop or unload) ends the run as an error, as it ends /v1/systemone', async (t) => {
  const engine = await standInEngine(t)
  const app = jobApp(deps(engine.target))
  await post(app, REQUEST)
  await engine.called()

  engine.stop()

  const ended = await settled(app)
  assert.equal(ended.state, 'error')
  assert.equal(ended.error?.code, 'engine_unreachable')
  assert.match(ended.error?.message ?? '', /^Engine unreachable: /)
  assert.ok(ended.finishedAt)
})

test('a second run while one runs is refused with 409 and the running one, and starts nothing', async (t) => {
  const engine = await standInEngine(t)
  const app = jobApp(deps(engine.target))
  const first = (await (await post(app, REQUEST)).json()) as SystemOneJobView
  await engine.called()

  const res = await post(app, { ...REQUEST, state: 'Another tab asks something else.' })
  assert.equal(res.status, 409)
  const refused = (await res.json()) as { error: { code: string; message: string }; run: SystemOneJobView }
  assert.equal(refused.error.code, 'run_in_progress')
  assert.equal(refused.run.id, first.id)
  assert.deepEqual(refused.run.request, REQUEST)
  await new Promise((r) => setTimeout(r, 50))
  assert.equal(engine.calls(), 1, 'nothing more reached the engine')

  engine.answer()
  assert.equal((await settled(app)).id, first.id)
  // Once it has ended, a new run starts.
  const next = await post(app, { ...REQUEST, state: 'Now it may.' })
  assert.equal(next.status, 202)
  assert.notEqual(((await next.json()) as SystemOneJobView).id, first.id)
  await engine.called(2)
  engine.answer()
})

test('a body /v1/systemone refuses is refused the same 422 way, and no run starts', async (t) => {
  const engine = await standInEngine(t)
  const app = jobApp(deps(engine.target))
  const res = await post(app, { ...REQUEST, questions: {} })
  assert.equal(res.status, 422)
  const gateway = new Hono()
  gateway.post('/v1/systemone', (c) => handleSystemOne(c, deps(engine.target)))
  const direct = await gateway.request('/v1/systemone', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...REQUEST, questions: {} }) })
  assert.deepEqual(await res.json(), await direct.json())
  assert.deepEqual(await view(app), { state: 'idle' })
  assert.equal(engine.calls(), 0)
})

test('a refusal once the run has started ends it as an error with /v1/systemone\'s code and message', async (t) => {
  const engine = await standInEngine(t)
  const app = jobApp(deps(engine.target))
  assert.equal((await post(app, { ...REQUEST, model: 'no-such-model' })).status, 202)
  const ended = await settled(app)
  assert.equal(ended.state, 'error')
  assert.deepEqual(ended.error, { code: 'model_not_found', message: "No local model matches 'no-such-model'." })
  assert.equal(engine.calls(), 0)
})

// ── Through lanAuth: a run ends once its caller's access is gone, as a chat reply does (auth.ts holdTurn) ─────────────

const RAW_A = 'tllm-playgroundjobplaygroundjobplaygrounda1'
type Socket = { localPort: number; remoteAddress: string }
const LAN: Socket = { localPort: 6996, remoteAddress: '192.168.1.50' }
const LOOPBACK: Socket = { localPort: 6996, remoteAddress: '127.0.0.1' }

class FakeProvider implements RemoteProvider {
  readonly id = 'custom' as const
  readonly lifecycle = 'none' as const
  async preflight(): Promise<PreflightState> { return { kind: 'off' } }
  async start(): Promise<{ url: string }> { return { url: 'https://phone.example.test' } }
  async stop(): Promise<void> {}
  alive(): boolean { return true }
}

/** A LAN-exposed daemon with key A, lanAuth in front of the job routes, and remote access on (a real
 *  RemoteAccessManager on an ephemeral ingress port, with a provider that only records a URL). `revoke` does what
 *  DELETE /api/v1/keys/:id does: drop the key and end what it held (endStaleStreams). */
async function gatedJob(t: { after: (fn: () => unknown) => void }, target: string) {
  const cfg: Config = defaultConfig()
  cfg.daemon.lanBind = true
  cfg.apiKeys.push({ id: 'kA', name: 'a', hash: hashKey(RAW_A), prefix: RAW_A.slice(0, 12), createdAt: '', lastUsedAt: null })
  const app = new Hono()
  const d = { ...deps(target), store: { snapshot: () => cfg, update: (fn: (c: Config) => void) => fn(cfg) } } as unknown as Deps
  const remote = new RemoteAccessManager({ app, ingressPort: 0, makeProvider: () => new FakeProvider(), probe: async () => true })
  ;(d as { remote: unknown }).remote = remote
  app.use('*', lanAuth(d))
  registerSystemOneJobRoutes(app, d)
  await remote.enable()
  t.after(() => remote.disable())
  const ingress: Socket = { localPort: remote.ingressPort()!, remoteAddress: '127.0.0.1' }
  const run = async (socket: Socket, key?: string): Promise<SystemOneJobView> => {
    const res = await app.request(SYSTEMONE_JOB_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
      body: JSON.stringify(REQUEST),
    }, { incoming: { socket: { ...socket, remotePort: 55555, remoteFamily: 'IPv4' } } } as never)
    assert.equal(res.status, 202, 'the run started')
    return (await res.json()) as SystemOneJobView
  }
  /** The host reads the run, polling until it is no longer running or `ms` have passed. */
  const read = async (ms = 2000): Promise<SystemOneJobView> => {
    const get = async () => (await (await app.request(SYSTEMONE_JOB_PATH, {}, { incoming: { socket: { ...LOOPBACK, remotePort: 55555, remoteFamily: 'IPv4' } } } as never)).json()) as SystemOneJobView
    let last = await get()
    for (const end = Date.now() + ms; last.state === 'running' && Date.now() < end;) {
      await new Promise((r) => setTimeout(r, 10))
      last = await get()
    }
    return last
  }
  const revoke = (id: string) => {
    cfg.apiKeys = cfg.apiKeys.filter((k) => k.id !== id)
    endStaleStreams(d)
  }
  const remoteToken = provisionRemoteApiKey(d, { kind: 'remote', capabilities: ['models:use'] })
  return { cfg, d, remote, ingress, run, read, revoke, remoteToken }
}

test('revoking the key a caller ran with, or requiring a key of a keyless open-LAN peer, cancels its run', async (t) => {
  const engine = await standInEngine(t)
  const g = await gatedJob(t, engine.target)

  const lan = await g.run(LAN, RAW_A)
  await engine.called(1)
  g.revoke('kA')
  const revoked = await g.read()
  assert.equal(revoked.id, lan.id)
  assert.equal(revoked.state, 'cancelled', 'the LAN key\'s run')
  await engine.until(() => engine.closedByCaller.length === 1)
  assert.deepEqual(engine.closedByCaller, [0], 'its engine call closed')

  const phone = await g.run(g.ingress, g.remoteToken)
  await engine.called(2)
  g.revoke(g.cfg.apiKeys.find((k) => k.hash === hashKey(g.remoteToken))!.id)
  assert.equal((await g.read()).state, 'cancelled', 'a remote-access token\'s run')
  assert.equal((await g.read()).id, phone.id)

  g.cfg.daemon.requireApiKey = false
  const open = await g.run(LAN)
  await engine.called(3)
  endStaleStreams(g.d)
  assert.equal((await g.read(100)).state, 'running', 'still let in: nothing changed for it')
  g.cfg.daemon.requireApiKey = true
  endStaleStreams(g.d)
  const required = await g.read()
  assert.equal(required.id, open.id)
  assert.equal(required.state, 'cancelled', 'the keyless open-LAN peer\'s run')
  await engine.until(() => engine.closedByCaller.length === 3)
  assert.deepEqual(engine.closedByCaller, [0, 1, 2])
})

test('turning LAN access off cancels the run a LAN peer started', async (t) => {
  const engine = await standInEngine(t)
  const g = await gatedJob(t, engine.target)
  const lan = await g.run(LAN, RAW_A)
  await engine.called(1)
  // LAN access turned off: PATCH /api/v1/settings rebinds onto loopback, and cli.ts listen() calls this on the bind.
  g.cfg.daemon.lanBind = false
  g.d.bindHost = '127.0.0.1'
  assert.equal(endLanTurns(g.d), 1)
  const ended = await g.read()
  assert.equal(ended.id, lan.id)
  assert.equal(ended.state, 'cancelled')
  await engine.until(() => engine.closedByCaller.length === 1)
  assert.deepEqual(engine.closedByCaller, [0], 'its engine call closed')
})

test('stopping remote access cancels the run that came through it', async (t) => {
  const engine = await standInEngine(t)
  const g = await gatedJob(t, engine.target)
  const phone = await g.run(g.ingress, g.remoteToken)
  await engine.called(1)
  await g.remote.disable()
  const ended = await g.read()
  assert.equal(ended.id, phone.id)
  assert.equal(ended.state, 'cancelled')
  await engine.until(() => engine.closedByCaller.length === 1)
  assert.deepEqual(engine.closedByCaller, [0], 'its engine call closed')
})

test('the host\'s own run is not cancelled by any of those, and ends once the engine answers', async (t) => {
  const engine = await standInEngine(t)
  const g = await gatedJob(t, engine.target)
  const host = await g.run(LOOPBACK)
  await engine.called(1)
  g.revoke('kA')
  g.cfg.daemon.requireApiKey = true
  endStaleStreams(g.d)
  g.cfg.daemon.lanBind = false
  g.d.bindHost = '127.0.0.1'
  endLanTurns(g.d)
  await g.remote.disable()
  await new Promise((r) => setTimeout(r, 50))
  assert.equal((await g.read(0)).state, 'running')
  assert.deepEqual(engine.closedByCaller, [], 'its engine call is still open')
  engine.answer()
  const done = await g.read()
  assert.equal(done.id, host.id)
  assert.equal(done.state, 'done')
})
