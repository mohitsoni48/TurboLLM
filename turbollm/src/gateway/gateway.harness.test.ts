// Regression/behaviour coverage for telemetry Phase 5 (spec 23 §3.5): the gateway used to read
// zero request headers. Verifies the plumbing end to end — a request's User-Agent header is
// classified (classify.ts's classifyHarness), persisted onto the api_usage row via
// recordApiUsage, and reported once per distinct harness via Emitter.harnessFirstSeen — at BOTH
// gateway entry points (/v1/messages Anthropic-protocol, /v1/chat/completions OpenAI-protocol).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import { registerGateway } from './gateway'
import { Emitter } from '../telemetry/emit'
import { readQueue } from '../telemetry/queue'
import type { Deps } from '../deps'

const LIBRARY = [{ key: 'qwen3-8b|Q4|123', name: 'Qwen3 8B' }]

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'turbollm-gateway-harness-'))
}

function makeTelemetry(dir: string): Emitter {
  const cfg = { telemetry: { level: 'full' as const, machineId: '55555555-5555-5555-5555-555555555555' } }
  const store = { snapshot: () => cfg, update: (fn: (c: typeof cfg) => void) => fn(cfg) }
  return new Emitter({ dataDir: dir, store: store as never, version: '1.11.0', os: 'win32/x64' })
}

function fakeDeps(telemetry: Emitter): { deps: Deps; recorded: Array<Record<string, unknown>> } {
  const recorded: Array<Record<string, unknown>> = []
  const deps = {
    scanner: { list: () => ({ models: LIBRARY, scanning: false, lastScanAt: '' }) },
    modelRouter: { route: async () => ({ target: 'http://engine.invalid.local:1' }) },
    store: { snapshot: () => ({ modelDefaults: { maxTokens: 0 }, gateway: { autoSwap: false } }) },
    manager: {
      status: () => ({ state: 'running', model: { name: 'Qwen3 8B', key: 'qwen3-8b|Q4|123' } }),
      target: () => 'http://engine.invalid.local:1',
      currentOpts: () => null,
      generationStart: () => {},
      generationEnd: () => {},
      recordCompletion: () => {},
    },
    registry: { active: () => ({ kind: 'llama.cpp' }) },
    db: { recordApiUsage: (rec: Record<string, unknown>) => { recorded.push(rec) } },
    telemetry,
  } as unknown as Deps
  return { deps, recorded }
}

/** A real, valid non-streaming OpenAI-shaped engine response — enough for both
 *  `mapFromOpenAI` (the /v1/messages response builder) and `recordOpenAiUsage`
 *  to run without throwing. */
function engineResponse(): Response {
  return new Response(
    JSON.stringify({ choices: [{ message: { content: 'hi' } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )
}

function stubFetch(): { restore: () => void } {
  const original = globalThis.fetch
  globalThis.fetch = (async () => engineResponse()) as typeof fetch
  return { restore: () => { globalThis.fetch = original } }
}

function harnessEventNames(dir: string): string[] {
  return readQueue(dir)
    .map((q) => q.event as { event: string })
    .filter((e) => e.event === 'harness_first_seen')
    .map((e) => e.event)
}

/** The /v1/* OpenAI passthrough's chat-completions usage recording is deliberately
 *  fire-and-forget (gateway.ts: `void drain.finally(...)`) — the handler returns the
 *  response to the client the moment the engine answers, without waiting for the teed
 *  copy to finish draining. Polls rather than a fixed sleep, so this stays fast on a
 *  quiet machine and still passes under load. */
async function waitFor(check: () => boolean, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) throw new Error('waitFor: condition never became true')
    await new Promise((r) => setTimeout(r, 5))
  }
}

test('/v1/chat/completions: a claude-cli User-Agent is classified, persisted, and reported once', async () => {
  const dir = tempDir()
  try {
    const telemetry = makeTelemetry(dir)
    const { deps, recorded } = fakeDeps(telemetry)
    const app = new Hono()
    registerGateway(app, deps)
    const fetchStub = stubFetch()
    try {
      const res = await app.request('/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': 'claude-cli/1.2.3' },
        body: JSON.stringify({ model: 'qwen3-8b|Q4|123', messages: [], stream: false }),
      })
      await res.text() // drain the client-facing copy, same as a real caller would
      await waitFor(() => recorded.length > 0)
    } finally { fetchStub.restore() }

    assert.equal(recorded.length, 1)
    assert.equal(recorded[0].harness, 'claude_code')
    assert.equal(harnessEventNames(dir).length, 1, 'harness_first_seen must fire exactly once')

    const payload = readQueue(dir).map((q) => q.event as { event: string; payload?: { harness: string; protocol: string } })
      .find((e) => e.event === 'harness_first_seen')?.payload
    assert.deepEqual(payload, { harness: 'claude_code', protocol: 'openai' })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('/v1/chat/completions: the same harness seen twice reports harness_first_seen only once', async () => {
  const dir = tempDir()
  try {
    const telemetry = makeTelemetry(dir)
    const { deps } = fakeDeps(telemetry)
    const app = new Hono()
    registerGateway(app, deps)
    const fetchStub = stubFetch()
    try {
      for (let i = 0; i < 2; i++) {
        await app.request('/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'User-Agent': 'opencode/0.1.0' },
          body: JSON.stringify({ model: 'qwen3-8b|Q4|123', messages: [], stream: false }),
        })
      }
    } finally { fetchStub.restore() }

    assert.equal(harnessEventNames(dir).length, 1, 'second request for the same harness must be a no-op')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('/v1/messages: no User-Agent at all classifies as unknown, not a guess, and is still recorded', async () => {
  const dir = tempDir()
  try {
    const telemetry = makeTelemetry(dir)
    const { deps, recorded } = fakeDeps(telemetry)
    const app = new Hono()
    registerGateway(app, deps)
    const fetchStub = stubFetch()
    try {
      await app.request('/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'qwen3-8b|Q4|123', max_tokens: 100, stream: false, messages: [] }),
      })
    } finally { fetchStub.restore() }

    assert.equal(recorded.length, 1)
    assert.equal(recorded[0].harness, 'unknown')
    assert.equal(recorded[0].source, 'anthropic')

    const payload = readQueue(dir).map((q) => q.event as { event: string; payload?: { harness: string; protocol: string } })
      .find((e) => e.event === 'harness_first_seen')?.payload
    assert.deepEqual(payload, { harness: 'unknown', protocol: 'anthropic' })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
