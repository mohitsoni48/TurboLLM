// `GET /api/v1/status` classifies a failed load so the UI can offer a remedy
// (ADR-338 Decision 4). Route-level rather than a unit test of `classifyLoadFailure`
// — that classifier already has its own tests; what was untested, and what actually
// broke the feature for a year, is that the answer never reached a client.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Hono } from 'hono'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { registerApi } from './routes'
import type { Deps } from '../deps'

type ErrLike = { code: string; message: string; exitCode: number; logTail: string[] }

// Double mirrors link-routes.status.test.ts's — the status route reads more of
// Manager/registry than this feature touches, and a thinner stub 500s.
function appWithEngineError(dataDir: string, err: ErrLike | undefined) {
  const cfg: Record<string, unknown> = {
    daemon: { lanBind: false, requireApiKey: false, port: 6996, machineId: 'm', machineName: 'test' },
    apiKeys: [],
    links: [],
    telemetry: { level: 'off', machineId: 'm' },
  }
  const app = new Hono()
  const d = {
    version: 'test',
    store: { snapshot: () => cfg, update: (fn: (c: never) => void) => fn(cfg as never), dir: () => dataDir },
    manager: {
      status: () => ({
        state: err ? 'error' : 'running',
        err: err ?? null,
        port: 8081,
        pid: 4242,
        model: { key: 'qwen3-35b', name: 'Qwen3 35B', quant: 'Q4_K_M', ctx: 32768, vision: false },
      }),
      launchCommand: () => undefined,
      parallelSlots: () => 4,
      sessionStats: () => null,
      liveGeneration: () => null,
    },
    registry: {
      active: () => ({ id: 'eng-1', name: 'llama.cpp', kind: 'llama.cpp', binPath: '/opt/turbollm/engines/llama-server' }),
    },
    bench: { status: () => ({ state: 'idle' }) },
    downloads: { activeCount: () => 0 },
    provision: { get: () => undefined },
    build: { get: () => undefined },
    tunnel: { snapshot: () => null },
  } as unknown as Deps
  registerApi(app, d)
  return app
}

async function statusEngine(err: ErrLike | undefined) {
  const dir = mkdtempSync(join(tmpdir(), 'tl-status-'))
  try {
    const res = await appWithEngineError(dir, err).request('/api/v1/status')
    const body = (await res.json()) as { engine?: { error?: { failReason?: string } } }
    return body.engine
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('status classifies an OOM load failure so the UI can offer a smaller quant', async () => {
  const engine = await statusEngine({
    code: 'model_load_failed',
    message: 'failed to load model',
    exitCode: -1,
    logTail: ['ggml_backend_cuda_buffer_type_alloc_buffer: cudaMalloc failed: out of memory'],
  })
  assert.equal(engine?.error?.failReason, 'oom')
})

// Order is load-bearing in the classifier: real OOM output ALSO contains
// "error loading model", so a naive top-down scan reports bad_gguf and sends
// the user to re-download a model that is not corrupt. Pinned here because the
// remedy offered differs entirely between the two.
test('an OOM that also looks like a load error is still classified as OOM, not corruption', async () => {
  const engine = await statusEngine({
    code: 'model_load_failed',
    message: 'error loading model',
    exitCode: -1,
    logTail: ['unable to allocate backend buffer'],
  })
  assert.equal(engine?.error?.failReason, 'oom')
})

test('a readiness timeout is classified from its structured code', async () => {
  const engine = await statusEngine({
    code: 'readiness_timeout',
    message: 'did not become ready',
    exitCode: -1,
    logTail: [],
  })
  assert.equal(engine?.error?.failReason, 'timeout')
})

// The UI falls back to 'other' on a missing field, and 'other' still yields actions —
// but the daemon should be explicit rather than relying on that fallback.
test('an unrecognised failure is reported as other, never omitted', async () => {
  const engine = await statusEngine({
    code: 'engine_exited',
    message: 'something nobody has seen before',
    exitCode: 3,
    logTail: [],
  })
  assert.equal(engine?.error?.failReason, 'other')
})

test('no engine error means no error block at all — the field is not fabricated', async () => {
  const engine = await statusEngine(undefined)
  assert.equal(engine?.error, undefined)
})

// The classification must not cost the caller the diagnostics it already had.
test('classifying preserves the original message, exitCode and logTail', async () => {
  const engine = await statusEngine({
    code: 'model_load_failed',
    message: 'out of memory',
    exitCode: -1,
    logTail: ['line one', 'line two'],
  })
  const err = engine?.error as unknown as ErrLike & { failReason: string }
  assert.equal(err.failReason, 'oom')
  assert.equal(err.message, 'out of memory')
  assert.equal(err.exitCode, -1)
  assert.deepEqual(err.logTail, ['line one', 'line two'])
})
