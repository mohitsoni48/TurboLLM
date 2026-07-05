// Part B: /v1/models discovery synthesis + `claude-`-prefixed model round-trip.
//   • GET /v1/models always lists the WHOLE local library (real key + `claude-<key>`
//     alias), regardless of whether an engine is running — this is what populates
//     Claude Code's /model picker via CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY.
//   • POST /v1/messages strips a leading `claude-` so the router + the outbound engine
//     request both see the REAL key.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Hono } from 'hono'
import { registerGateway } from './gateway'
import type { Deps } from '../deps'

const LIBRARY = [
  { key: 'qwen3-8b|Q4|123', name: 'Qwen3 8B' },
  { key: 'llama-3-70b|Q5|456', name: 'Llama 3 70B' },
]

/** Minimal Deps double: only the members the tested gateway paths touch. */
function fakeDeps(routed: { model: string | null }, autoSwap = true): Deps {
  return {
    scanner: { list: () => ({ models: LIBRARY, scanning: false, lastScanAt: '' }) },
    modelRouter: {
      route: async (m: string) => {
        routed.model = m
        return { target: 'http://engine.local' }
      },
    },
    store: { snapshot: () => ({ modelDefaults: { maxTokens: 0 }, gateway: { autoSwap } }) },
    manager: {
      status: () => ({ state: 'stopped', model: null }),
      target: () => 'http://engine.local',
      generationStart: () => {},
      generationEnd: () => {},
    },
    registry: { active: () => ({ kind: 'llama.cpp' }) },
  } as unknown as Deps
}

// ── GET /v1/models synthesis ────────────────────────────────────────────────────

test('GET /v1/models lists the whole library (real key + claude- alias) even with no engine', async () => {
  const app = new Hono()
  registerGateway(app, fakeDeps({ model: null }))

  const res = await app.request('/v1/models', { method: 'GET' })
  assert.equal(res.status, 200)
  const body = (await res.json()) as { object: string; data: Array<Record<string, unknown>> }
  assert.equal(body.object, 'list')
  // Two entries per library model: real key + claude- alias.
  assert.equal(body.data.length, LIBRARY.length * 2)

  const real = body.data.find((e) => e.id === 'qwen3-8b|Q4|123')
  assert.ok(real, 'real-key entry present')
  assert.equal(real!.owned_by, 'turbollm')

  const alias = body.data.find((e) => e.id === 'claude-qwen3-8b|Q4|123')
  assert.ok(alias, 'claude- alias present for Claude Code discovery')
  assert.equal(alias!.display_name, 'Qwen3 8B — TurboLLM')
})

test('GET /v1/models omits claude- aliases when gateway.autoSwap is off', async () => {
  const app = new Hono()
  registerGateway(app, fakeDeps({ model: null }, false))

  const res = await app.request('/v1/models', { method: 'GET' })
  const body = (await res.json()) as { data: Array<Record<string, unknown>> }
  // Real-key entries still list (useful to OpenAI-style consumers regardless of autoSwap),
  // but no claude- aliases — advertising them would let /model pick a model that autoSwap
  // being off silently prevents from ever loading.
  assert.equal(body.data.length, LIBRARY.length)
  assert.ok(body.data.every((e) => !(e.id as string).startsWith('claude-')))
})

// ── POST /v1/messages claude- prefix strip ──────────────────────────────────────

test('POST /v1/messages strips a claude- prefix before routing', async () => {
  const routed = { model: null as string | null }
  const app = new Hono()
  registerGateway(app, fakeDeps(routed))

  // The engine fetch will fail (no real server) — we only assert on what the router saw.
  await app.request('/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'claude-llama-3-70b|Q5|456', max_tokens: 10, messages: [] }),
  })

  assert.equal(routed.model, 'llama-3-70b|Q5|456', 'router must see the real key, not the claude- alias')
})

test('POST /v1/messages leaves a non-prefixed model id untouched', async () => {
  const routed = { model: null as string | null }
  const app = new Hono()
  registerGateway(app, fakeDeps(routed))

  await app.request('/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'qwen3-8b|Q4|123', max_tokens: 10, messages: [] }),
  })

  assert.equal(routed.model, 'qwen3-8b|Q4|123')
})
