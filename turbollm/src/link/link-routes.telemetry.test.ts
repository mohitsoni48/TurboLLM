// Turbo Link telemetry attribution (ADR-376 spec §5.6, phase 2 task 9).
//
// The rule is one sentence and the whole file exists to hold it: a federated generation is
// reported by the machine that DID the work (the host), and by nobody else. Without it
// every generation in a two-machine setup is counted twice — once by the peer that took
// the click and once by the host that ran the tokens — and every derived funnel is quietly
// wrong by a factor that grows with how many machines the user links.
//
// So both halves are asserted in ONE file, against the SAME event queue: proving "the host
// emits" and "the peer does not" in two separate files would let the pair drift into
// double-counting with both files still green.
import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { Hono } from 'hono'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { registerLinkApi } from './link-routes'
import { registerGateway } from '../gateway/gateway'
import { resetLocalActivity } from './host-idle'
import { Emitter } from '../telemetry/emit'
import { readQueue } from '../telemetry/queue'
import type { Deps } from '../deps'
import type { ApiKey } from '../config/config'

const LOADED = 'gemma-27b'
const COLD = 'qwen3-35b'
const LINK_TOKEN = 'tllm-hostsecret-abc123'
const HOST_URL = 'https://rig.trycloudflare.com'
const MACHINE_NAME = 'workstation'

function key(raw: string, caps: string[]): ApiKey {
  return {
    id: randomUUID(), name: 'laptop', hash: createHash('sha256').update(raw).digest('hex'),
    prefix: raw.slice(0, 12), createdAt: 'c', lastUsedAt: null,
    grant: { capabilities: caps as never },
  }
}

/** Real `Emitter` over a temp data dir at `anon` consent — the same convention as
 *  `telemetry/emit.test.ts` and `link-admin-routes.test.ts`. Nothing leaves the machine:
 *  the emitter only ever writes the local queue file, which is what `readQueue` reads. */
function mkTelemetry(): { telemetry: Emitter; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'turbollm-link-attribution-'))
  const cfg = { telemetry: { level: 'anon', machineId: '44444444-4444-4444-4444-444444444444' } }
  const telemetry = new Emitter({
    dataDir: dir,
    store: { snapshot: () => cfg, update: (fn: (c: typeof cfg) => void) => fn(cfg) } as never,
    version: '1.11.2',
    os: 'win32/x64',
  })
  return { telemetry, dir }
}

function inferenceEvents(dir: string): Record<string, unknown>[] {
  // `readQueue` returns `{ file, event }` wrappers, and DROPS anything that fails
  // `validateEvent` — so a payload that does not match the registered schema shows up here
  // as an absent event, not a wrong one. Same unwrapping as link-admin-routes.test.ts.
  return readQueue(dir)
    .map((q) => q.event as { event: string; payload?: Record<string, unknown> })
    .filter((e) => e.event === 'inference_served')
    .map((e) => e.payload ?? {})
}

// ── Host side: the machine that actually ran the tokens ────────────────────────────────

function hostDeps(keys: ApiKey[], telemetry?: Emitter): Deps {
  const cfg: Record<string, unknown> = {
    apiKeys: keys, links: [], daemon: { lanBind: true, requireApiKey: true, machineId: 'machine-abc', machineName: MACHINE_NAME },
    gateway: { autoSwap: true }, modelDefaults: { maxTokens: 0 },
  }
  return {
    version: '1.11.2',
    store: { snapshot: () => cfg, update: (fn: (c: never) => void) => fn(cfg as never) },
    scanner: { list: () => ({ models: [], scanning: false, lastScanAt: '' }) },
    db: { recordApiUsage: () => {} },
    registry: { active: () => ({ kind: 'llama.cpp' }) },
    modelRouter: { route: async () => ({ target: 'http://engine.local' }), resolveRemoteTarget: () => undefined },
    manager: {
      status: () => ({ state: 'running', model: { key: LOADED } }),
      target: () => 'http://engine.local',
      currentOpts: () => ({ modelPath: '' }),
      sessionStats: () => ({ activeRequests: 0 }),
      generationStart: () => {}, generationEnd: () => {}, recordCompletion: () => {},
    },
    ...(telemetry ? { telemetry } : {}),
  } as unknown as Deps
}

function postToFacade(d: Deps, model: string, extra?: Record<string, unknown>) {
  const app = new Hono()
  registerLinkApi(app, d)
  return app.request('/api/link/v1/chat/completions', {
    method: 'POST',
    headers: { 'X-TurboLLM-Auth': LINK_TOKEN, 'content-type': 'application/json' },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }], ...extra }),
  })
}

const realFetch = globalThis.fetch
const dirs: string[] = []
beforeEach(() => {
  resetLocalActivity()
  globalThis.fetch = (async () => new Response(
    JSON.stringify({ choices: [{ message: { content: 'hi' } }], usage: { prompt_tokens: 3, completion_tokens: 4 } }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )) as typeof fetch
})
afterEach(() => {
  globalThis.fetch = realFetch
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function telemetryDir(): { telemetry: Emitter; dir: string } {
  const t = mkTelemetry()
  dirs.push(t.dir)
  return t
}

test('the HOST reports a proxied generation exactly once, tagged via:link', async () => {
  const { telemetry, dir } = telemetryDir()
  const res = await postToFacade(hostDeps([key(LINK_TOKEN, ['models:use'])], telemetry), LOADED)
  assert.equal(res.status, 200)
  const events = inferenceEvents(dir)
  assert.equal(events.length, 1, 'exactly one inference event per generation')
  assert.equal(events[0].via, 'link')
  assert.equal(events[0].outcome, 'ok')
})

test('a streamed generation is still exactly ONE event, flagged as streamed', async () => {
  const { telemetry, dir } = telemetryDir()
  await postToFacade(hostDeps([key(LINK_TOKEN, ['models:use'])], telemetry), LOADED, { stream: true })
  const events = inferenceEvents(dir)
  assert.equal(events.length, 1)
  assert.equal(events[0].streamed, true)
})

test('a request the wake gate REFUSED is not counted as a generation', async () => {
  // A typed 503 means the host never ran a token. Counting it would inflate exactly the
  // number this event exists to measure.
  const { telemetry, dir } = telemetryDir()
  const res = await postToFacade(hostDeps([key(LINK_TOKEN, ['models:use'])], telemetry), COLD)
  assert.equal(res.status, 503)
  assert.equal(inferenceEvents(dir).length, 0)
})

test('a model the grant forbids is not counted as a generation either', async () => {
  const { telemetry, dir } = telemetryDir()
  const d = hostDeps([{ ...key(LINK_TOKEN, ['models:use']), grant: { capabilities: ['models:use'] as never, models: ['something-else'] } }], telemetry)
  const res = await postToFacade(d, LOADED)
  assert.equal(res.status, 403)
  assert.equal(inferenceEvents(dir).length, 0)
})

test('emission is a no-op when telemetry is absent — the generation still succeeds', async () => {
  // `d.telemetry` is optional (absent under tests and whenever the emitter failed to
  // construct). Attribution must never be the reason a generation fails.
  const res = await postToFacade(hostDeps([key(LINK_TOKEN, ['models:use'])]), LOADED)
  assert.equal(res.status, 200)
})

test('a throwing emitter can never break or delay a proxied generation', async () => {
  const exploding = { emit: () => { throw new Error('telemetry is down') } } as unknown as Emitter
  const res = await postToFacade(hostDeps([key(LINK_TOKEN, ['models:use'])], exploding), LOADED)
  assert.equal(res.status, 200)
})

test('the payload can carry no token, url, hostname, machine name, or model key', async () => {
  // Asserted on the SERIALIZED text, not a parsed object, so a nested or renamed field
  // cannot slip past a narrowly-typed assertion — same convention as events/link.test.ts.
  const { telemetry, dir } = telemetryDir()
  await postToFacade(hostDeps([key(LINK_TOKEN, ['models:use'])], telemetry), LOADED)
  const text = JSON.stringify(readQueue(dir))
  assert.ok(!text.includes('tllm-'), 'no raw token')
  assert.ok(!text.includes(LINK_TOKEN))
  assert.ok(!text.includes(HOST_URL))
  assert.ok(!/https?:\/\//.test(text), 'no URL of any kind')
  assert.ok(!text.includes(MACHINE_NAME), 'no machine name')
  assert.ok(!text.includes(LOADED), 'no model key')
})

// ── Peer side: the machine that took the click and proxied the request out ──────────────

function peerDeps(telemetry: Emitter): Deps {
  const remote = { linkId: 'lnk1', baseUrl: HOST_URL, token: LINK_TOKEN, modelKey: COLD }
  return {
    scanner: { list: () => ({ models: [], scanning: false, lastScanAt: '' }) },
    modelRouter: { route: async () => ({ target: remote.baseUrl, remote }) },
    store: { snapshot: () => ({ modelDefaults: { maxTokens: 0 }, gateway: { autoSwap: true } }) },
    manager: {
      status: () => ({ state: 'stopped', model: null }),
      target: () => null, currentOpts: () => null,
      generationStart: () => {}, generationEnd: () => {}, recordCompletion: () => {}, setLiveGen: () => {},
    },
    registry: { active: () => ({ kind: 'llama.cpp' }) },
    db: { recordApiUsage: () => {} },
    telemetry,
  } as unknown as Deps
}

test('the PEER reports no inference event for a generation it proxied out', async () => {
  const { telemetry, dir } = telemetryDir()
  const app = new Hono()
  registerGateway(app, peerDeps(telemetry))
  const res = await app.request('http://local.test/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: `${MACHINE_NAME}/${COLD}`, messages: [{ role: 'user', content: 'hi' }] }),
  })
  assert.equal(res.status, 200)
  // The host already counted this one. A second event here is the double count.
  assert.equal(inferenceEvents(dir).length, 0)
})

test('the PEER reports no inference event on the Anthropic protocol either', async () => {
  // Both gateway entry points proxy through the same remote branch; instrumenting one and
  // not the other would double-count exactly half of all federated traffic.
  const { telemetry, dir } = telemetryDir()
  const app = new Hono()
  registerGateway(app, peerDeps(telemetry))
  await app.request('http://local.test/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: `${MACHINE_NAME}/${COLD}`, max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] }),
  })
  assert.equal(inferenceEvents(dir).length, 0)
})
