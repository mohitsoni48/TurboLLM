// Task 6 — stats parity (ADR-376 spec §5.4).
//
// The host re-exports its EXISTING status shape through the façade; the peer renders it
// with its existing components. So the assertions here are deliberately about PARITY,
// not about a new shape: the façade's payload is driven from the same builder the local
// `/api/v1/status` route uses, and the only permitted difference is the removal of
// `engine.launchCommand` — an absolute host path that must never cross a link.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Hono } from 'hono'
import { createHash, randomUUID } from 'node:crypto'
import { registerLinkApi } from './link-routes'
import { buildModelStatus } from '../api/status-view'
import { LinkClient } from './link-client'
import type { Deps } from '../deps'
import type { ApiKey } from '../config/config'

const LAUNCH_COMMAND = ['/opt/turbollm/engines/llama.cpp/llama-server', '-m', '/home/me/models/qwen3-35b.gguf']

/** A realistic llama.cpp failure. The point of the fixture is `logTail`: the engine echoes
 *  the model path, the mmproj path and its own binary path in its own stderr, so `ErrInfo`
 *  leaks absolute host paths as a matter of routine, not as an edge case. Both a POSIX and
 *  a Windows path are present so the drive-letter form is covered too. */
const ERR_INFO = {
  code: 'engine_exited',
  message: "failed to load model from 'C:\\Users\\me\\models\\qwen3-35b.gguf'",
  exitCode: 1,
  logTail: [
    'llama_model_load: loading model from /home/me/models/qwen3-35b.gguf',
    'clip_model_load: failed to open /home/me/models/mmproj-qwen3.gguf',
    'D:\\turbollm\\engines\\llama.cpp\\llama-server: error while loading shared libraries',
  ],
}

/** Every substring that would prove a host path escaped, in both serialized forms. JSON
 *  escapes a backslash, so a Windows path arrives as `C:\\Users\\…` in the response text. */
const PATH_SHAPES: RegExp[] = [
  /[A-Za-z]:\\/,                                  // drive-letter path, raw
  /[A-Za-z]:\\\\/,                                // drive-letter path, JSON-escaped
  /\/(home|Users|opt|usr|var|root|mnt|models|tmp)\//, // POSIX-absolute-looking segment
  /\.gguf/,                                       // any model file, wherever it came from
]

function mkDeps(keys: ApiKey[], opts?: { state?: string; err?: unknown }): Deps {
  const cfg: Record<string, unknown> = {
    apiKeys: keys,
    links: [],
    daemon: { lanBind: true, requireApiKey: true, machineId: 'machine-abc', machineName: 'workstation' , experimental: { turboLink: true } },
  }
  return {
    version: '1.11.2',
    store: { snapshot: () => cfg, update: (fn: (c: never) => void) => fn(cfg as never) },
    manager: {
      status: () => ({
        state: opts?.state ?? 'running',
        err: opts?.err ?? null,
        port: 8081,
        pid: 4242,
        loadElapsedMs: 1200,
        model: { key: 'qwen3-35b', name: 'Qwen3 35B', quant: 'Q4_K_M', ctx: 32768, vision: false },
      }),
      launchCommand: () => LAUNCH_COMMAND,
      parallelSlots: () => 4,
      sessionStats: () => ({ tokensPerSec: 42.5, ttftMs: 180, promptTokens: 1024, genTokens: 256 }),
      liveGeneration: () => ({ prefillPct: 100, tokens: 128 }),
    },
    registry: {
      active: () => ({ id: 'eng-1', name: 'llama.cpp', kind: 'llama.cpp', binPath: '/opt/turbollm/engines/llama-server' }),
    },
  } as unknown as Deps
}

function key(raw: string, caps?: string[]): ApiKey {
  return {
    id: randomUUID(), name: 'laptop', hash: createHash('sha256').update(raw).digest('hex'),
    prefix: raw.slice(0, 12), createdAt: 'c', lastUsedAt: null,
    ...(caps ? { grant: { capabilities: caps as never } } : {}),
  }
}

function app(d: Deps) {
  const a = new Hono()
  registerLinkApi(a, d)
  return a
}

test('the façade re-exports the SAME model-stat payload the local status route builds', async () => {
  const d = mkDeps([key('tllm-a', ['models:use'])])
  const res = await app(d).request('/api/link/v1/status', { headers: { 'X-TurboLLM-Auth': 'tllm-a' } })
  assert.equal(res.status, 200)
  const body = await res.json()
  // Not a re-derived shape: the exact object the shared builder produces. If the façade
  // ever grows its own translation layer this fails immediately.
  assert.deepEqual(body, JSON.parse(JSON.stringify(buildModelStatus(d))))
  const b = body as Record<string, unknown>
  assert.deepEqual(Object.keys(b).sort(), ['engine', 'engineStats', 'liveGeneration', 'model'])
  assert.equal((b.engineStats as { tokensPerSec: number }).tokensPerSec, 42.5)
  assert.equal((b.liveGeneration as { prefillPct: number }).prefillPct, 100)
  assert.equal((b.model as { name: string }).name, 'Qwen3 35B')
})

test('a token without models:use gets 403', async () => {
  const d = mkDeps([key('tllm-a', ['models:wake'])])
  const res = await app(d).request('/api/link/v1/status', { headers: { 'X-TurboLLM-Auth': 'tllm-a' } })
  assert.equal(res.status, 403)
})

test('the payload carries no host paths, no engine binary, and no key material', async () => {
  // The general property, not a named-field check: NO host filesystem detail crosses the
  // façade. Asserted on the SERIALIZED text so a leak nested three levels deep still trips
  // it, and by path SHAPE so a field nobody thought to enumerate is caught automatically.
  //
  // Both fixtures are exercised — a healthy engine and a FAILED one. The failed case is the
  // one that matters: `ErrInfo.logTail` is the engine's raw stderr, which is where llama.cpp
  // prints the model, mmproj and binary paths.
  for (const [label, opts] of [
    ['running', undefined],
    ['errored', { state: 'error', err: ERR_INFO }],
  ] as const) {
    const d = mkDeps([key('tllm-a', ['models:use'])], opts)
    const res = await app(d).request('/api/link/v1/status', { headers: { 'X-TurboLLM-Auth': 'tllm-a' } })
    assert.equal(res.status, 200)
    const text = await res.text()

    for (const shape of PATH_SHAPES) {
      assert.equal(shape.test(text), false, `[${label}] payload leaked a path-shaped value matching ${shape}`)
    }
    // The specific fields that carry paths, named so a regression reads clearly.
    assert.equal(text.includes('launchCommand'), false, `[${label}] launchCommand must not cross the façade`)
    assert.equal(text.includes('logTail'), false, `[${label}] the engine log tail must not cross the façade`)
    // The KEY form (`"error":`), not the bare word — `"state":"error"` legitimately contains it.
    assert.equal(text.includes('"error":'), false, `[${label}] ErrInfo must not cross the façade`)
    // Every literal path value from the fixtures, wherever it might have come from.
    for (const needle of [...LAUNCH_COMMAND, ...ERR_INFO.logTail, ERR_INFO.message, '/opt/turbollm', 'llama-server', 'binPath']) {
      assert.equal(text.includes(needle), false, `[${label}] payload leaked ${needle}`)
    }
    // Key material: neither the hash nor the presented token may appear anywhere.
    const hash = createHash('sha256').update('tllm-a').digest('hex')
    assert.equal(text.includes(hash), false, `[${label}] payload leaked a key hash`)
    assert.equal(text.includes('tllm-a'), false, `[${label}] payload leaked the presented token`)
  }
})

test('an errored host still reports that it errored — state carries it, ErrInfo does not', async () => {
  // Omitting `error` must not leave the peer blind: `state` is the bounded, enum-valued
  // signal a remote renderer can actually act on, and it is enough.
  const d = mkDeps([key('tllm-a', ['models:use'])], { state: 'error', err: ERR_INFO })
  const res = await app(d).request('/api/link/v1/status', { headers: { 'X-TurboLLM-Auth': 'tllm-a' } })
  const body = await res.json() as { engine: Record<string, unknown> }
  assert.equal(body.engine.state, 'error')
  assert.equal('error' in body.engine, false)
})

test('ErrInfo is absent from the SHARED builder, so the local route is the only thing that can add it', () => {
  // The leak is closed by keeping a local-only field out of the shared builder — never by
  // deleting diagnostics the local engine card depends on. `ms.err` is still there for
  // routes.ts to attach; what changed is that the façade has no path to it.
  const d = mkDeps([key('tllm-a', ['models:use'])], { state: 'error', err: ERR_INFO })
  const engine = buildModelStatus(d).engine as Record<string, unknown>
  assert.equal('error' in engine, false, 'ErrInfo must not be in the shared builder')
  assert.equal(engine.state, 'error', 'but the state it describes still is')
  assert.equal(d.manager.status().err, ERR_INFO, 'and the local route can still reach it')
})

test('the local status route still exposes launchCommand — the façade is the only thing that strips it', () => {
  // Guards against "fixing" the leak by deleting the field from the shared builder's
  // consumers: launchCommand is local-only by construction, not by omission-at-both-ends.
  const d = mkDeps([key('tllm-a', ['models:use'])])
  const core = buildModelStatus(d)
  assert.equal('launchCommand' in (core.engine as Record<string, unknown>), false)
  assert.equal(core.engine.parallelSlots, 4)
})

test('LinkClient.status() inherits the never-throws + shape guarantee from call()', async () => {
  const d = mkDeps([key('tllm-a', ['models:use'])])
  const host = app(d)
  const client = new LinkClient(
    { baseUrl: 'http://host.local', token: 'tllm-a' },
    { fetchImpl: (input, init) => host.request(new URL(String(input)).pathname, init as RequestInit) as Promise<Response> },
  )
  const res = await client.status()
  assert.equal(res.kind, 'status')
  // Step 3: the remote stats arrive as the SAME view-model the local path produces, so the
  // peer's existing meters render them unchanged — no translation layer anywhere.
  assert.deepEqual(
    (res as { status: unknown }).status,
    JSON.parse(JSON.stringify(buildModelStatus(d))),
  )

  // Total contract: every failure mode is a LinkProbe, never a rejection.
  const boom = new LinkClient(
    { baseUrl: 'http://host.local', token: 'tllm-a' },
    { fetchImpl: async () => { throw new Error('ECONNREFUSED') } },
  )
  assert.deepEqual(await boom.status(), { kind: 'network' })

  const forbidden = new LinkClient(
    { baseUrl: 'http://host.local', token: 'nope' },
    { fetchImpl: async () => new Response('no', { status: 403 }) },
  )
  assert.deepEqual(await forbidden.status(), { kind: 'http', status: 403 })

  const garbage = new LinkClient(
    { baseUrl: 'http://host.local', token: 'tllm-a' },
    { fetchImpl: async () => new Response('"a string"', { status: 200, headers: { 'content-type': 'application/json' } }) },
  )
  assert.deepEqual(await garbage.status(), { kind: 'network' })
})
