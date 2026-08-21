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

function mkDeps(keys: ApiKey[]): Deps {
  const cfg: Record<string, unknown> = {
    apiKeys: keys,
    links: [],
    daemon: { lanBind: true, requireApiKey: true, machineId: 'machine-abc', machineName: 'workstation' },
  }
  return {
    version: '1.11.2',
    store: { snapshot: () => cfg, update: (fn: (c: never) => void) => fn(cfg as never) },
    manager: {
      status: () => ({
        state: 'running',
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
  const d = mkDeps([key('tllm-a', ['models:use'])])
  const res = await app(d).request('/api/link/v1/status', { headers: { 'X-TurboLLM-Auth': 'tllm-a' } })
  // Assert on the SERIALIZED text: a leak nested three levels deep is still a leak, and a
  // key-by-key check would only ever cover the fields someone remembered to look at.
  const text = await res.text()
  assert.equal(text.includes('launchCommand'), false, 'launchCommand must not cross the façade')
  for (const needle of ['/opt/turbollm', '/home/me', 'llama-server', '.gguf', 'binPath']) {
    assert.equal(text.includes(needle), false, `payload leaked ${needle}`)
  }
  // Key material: neither the hash nor the presented token may appear anywhere.
  const hash = createHash('sha256').update('tllm-a').digest('hex')
  assert.equal(text.includes(hash), false, 'payload leaked a key hash')
  assert.equal(text.includes('tllm-a'), false, 'payload leaked the presented token')
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
