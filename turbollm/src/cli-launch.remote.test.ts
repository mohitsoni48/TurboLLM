// Task 7 — `turbollm launch <cli> --model <machine>/<model>` (ADR-376 §1 decision 7).
//
// A qualified id names a model on a LINKED host. Nothing about it is local: there is no
// local key to resolve, nothing to load, and no local engine that has to be running. The
// launcher's job is to confirm the daemon really advertises that id (so a typo fails here
// rather than silently at the first prompt) and then pin it verbatim, because the gateway's
// ModelRouter is what routes it to the host.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { EventEmitter } from 'node:events'
import { launchCli } from './cli-launch.js'

interface CapturedSpawn {
  cmd: string
  args: string[]
  env: Record<string, string | undefined>
}

function makeSpawn(): { calls: CapturedSpawn[]; fn: Parameters<typeof launchCli>[3] } {
  const calls: CapturedSpawn[] = []
  const fn: Parameters<typeof launchCli>[3] = (cmd, args, opts) => {
    calls.push({ cmd, args, env: (opts?.env ?? {}) as Record<string, string | undefined> })
    const ee = new EventEmitter() as ReturnType<typeof import('node:child_process').spawn>
    setImmediate(() => ee.emit('exit', 0, null))
    return ee
  }
  return { calls, fn }
}

/** Same rationale as cli-launch.model.test.ts: swallow only launchCli's own '▸' banner
 *  lines, never the V8-serialized channel node:test's parent runner reads. */
function silenceOutput(): { stderr: () => string; restore: () => void } {
  const outW = process.stdout.write.bind(process.stdout)
  const errW = process.stderr.write.bind(process.stderr)
  let err = ''
  process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
    if (String(chunk).startsWith('▸')) return true
    return (outW as (...a: unknown[]) => boolean)(chunk, ...rest)
  }) as typeof process.stdout.write
  process.stderr.write = ((chunk: string | Uint8Array) => { err += String(chunk); return true }) as typeof process.stderr.write
  return {
    stderr: () => err,
    restore: () => { process.stdout.write = outW; process.stderr.write = errW },
  }
}

const LOCAL = [{ key: 'qwen3-8b', name: 'Qwen3 8B' }]

interface Hits { engineStart: number; gatewayModels: number }

/** Daemon double. `engineState: 'idle'` means NO local model is loaded — the realistic
 *  state for a laptop whose whole point is borrowing the workstation's GPU. */
function makeFetch(
  gatewayIds: string[],
  hits: Hits,
  engineState: 'running' | 'idle' = 'idle',
  /** ADR-382: what the UI has this install pointed at, as /status reports it. */
  selectedRemoteModel = '',
): typeof fetch {
  const fn = async (input: string | URL | globalThis.Request): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url

    if (url.includes('/api/v1/status')) {
      const body = engineState === 'running'
        ? { engine: { state: 'running' }, model: { key: LOCAL[0].key, name: LOCAL[0].name }, selectedRemoteModel }
        : { engine: { state: 'idle' }, model: null, selectedRemoteModel }
      return { ok: true, status: 200, json: async () => body } as Response
    }
    if (url.includes('/api/v1/models')) {
      return { ok: true, status: 200, json: async () => ({ models: LOCAL }) } as Response
    }
    if (url.includes('/api/v1/engine/start')) {
      hits.engineStart++
      return { ok: true, status: 202, json: async () => ({ ok: true }) } as Response
    }
    if (url.includes('/v1/models')) {
      hits.gatewayModels++
      return {
        ok: true,
        status: 200,
        json: async () => ({ object: 'list', data: gatewayIds.map((id) => ({ id, object: 'model' })) }),
      } as Response
    }
    return { ok: false, status: 404, json: async () => ({}) } as Response
  }
  return fn as unknown as typeof fetch
}

test('--model <machine>/<model> pins the qualified id and loads nothing locally', async () => {
  const { calls, fn } = makeSpawn()
  const hits: Hits = { engineStart: 0, gatewayModels: 0 }
  const out = silenceOutput()
  try {
    const code = await launchCli(
      'claude', 6996, [], fn,
      'workstation/Qwen3-35B',
      makeFetch(['qwen3-8b', 'workstation/Qwen3-35B'], hits),
    )
    assert.equal(code, 0, 'launch must succeed with NO local model loaded')
    assert.equal(calls.length, 1)
    // Verbatim: the qualified id is what the gateway's ModelRouter resolves remotely.
    assert.equal(calls[0].env['ANTHROPIC_MODEL'], 'workstation/Qwen3-35B')
    assert.equal(hits.engineStart, 0, 'a remote model must never trigger a LOCAL engine load')
    assert.ok(hits.gatewayModels > 0, 'the id must be validated against what the daemon advertises')
  } finally {
    out.restore()
  }
})

test('a qualified id the daemon does not advertise fails loudly instead of falling back', async () => {
  const { calls, fn } = makeSpawn()
  const hits: Hits = { engineStart: 0, gatewayModels: 0 }
  const out = silenceOutput()
  try {
    // The offline-link case in practice: the machine is linked but contributes no models,
    // so the id is simply absent. Answering with the local model instead would run the
    // prompt on the wrong weights — invariant 5 says fail loudly.
    const code = await launchCli(
      'claude', 6996, [], fn,
      'workstation/Qwen3-35B',
      makeFetch(['qwen3-8b'], hits),
    )
    assert.equal(code, 1)
    assert.equal(calls.length, 0, 'nothing may be spawned')
    assert.match(out.stderr(), /not found/i)
    assert.equal(hits.engineStart, 0)
  } finally {
    out.restore()
  }
})

test('a LOCAL key containing a slash still resolves locally, unchanged', async () => {
  // `unsloth/Qwen3-GGUF` parses as qualified but names no linked machine. Local
  // resolution must still win — this is the regression Task 7 must not introduce.
  const { calls, fn } = makeSpawn()
  const hits: Hits = { engineStart: 0, gatewayModels: 0 }
  const out = silenceOutput()
  const slashy = [{ key: 'unsloth/Qwen3-GGUF', name: 'Qwen3 GGUF' }]
  const fetchImpl = (async (input: string | URL | globalThis.Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    if (url.includes('/api/v1/status')) {
      return { ok: true, status: 200, json: async () => ({ engine: { state: 'running' }, model: { key: 'unsloth/Qwen3-GGUF', name: 'Qwen3 GGUF' } }) } as Response
    }
    if (url.includes('/api/v1/models')) return { ok: true, status: 200, json: async () => ({ models: slashy }) } as Response
    if (url.includes('/api/v1/engine/start')) { hits.engineStart++; return { ok: true, status: 202, json: async () => ({}) } as Response }
    if (url.includes('/v1/models')) { hits.gatewayModels++; return { ok: true, status: 200, json: async () => ({ data: [{ id: 'unsloth/Qwen3-GGUF' }] }) } as Response }
    return { ok: false, status: 404, json: async () => ({}) } as Response
  }) as unknown as typeof fetch
  try {
    const code = await launchCli('claude', 6996, [], fn, 'unsloth/Qwen3-GGUF', fetchImpl)
    assert.equal(code, 0)
    assert.equal(calls[0].env['ANTHROPIC_MODEL'], 'unsloth/Qwen3-GGUF')
    assert.equal(hits.engineStart, 0, 'already loaded — no reload')
  } finally {
    out.restore()
  }
})

// ── ADR-382: no --model, but the UI has this install pointed at a linked machine ─────────
//
// The founder-reported symptom, verbatim: `turbollm launch pi` printed
// "Auto-loading model qwen3.8-27b…", gave up after 180 s, and crashed — while the UI showed a
// cloud model selected and ready. The selection lived only in the browser, so this process
// never saw it. It is daemon state now (/status's selectedRemoteModel), and these tests fail
// if the CLI ever goes back to guessing a local model instead of reading it.

test('no --model: the daemon-side remote selection is used, and NOTHING is loaded locally', async () => {
  const { calls, fn } = makeSpawn()
  const hits: Hits = { engineStart: 0, gatewayModels: 0 }
  const out = silenceOutput()
  try {
    const code = await launchCli(
      'claude', 6996, [], fn,
      undefined,
      makeFetch(['qwen3-8b', 'workstation/Qwen3-35B'], hits, 'idle', 'workstation/Qwen3-35B'),
    )
    assert.equal(code, 0)
    assert.equal(calls[0].env['ANTHROPIC_MODEL'], 'workstation/Qwen3-35B')
    // THE bug: this used to be 1 — a 180-second local load nobody asked for.
    assert.equal(hits.engineStart, 0, 'a remote selection must never trigger a local auto-load')
  } finally {
    out.restore()
  }
})

test('the remote selection wins over a model that happens to be loaded locally', async () => {
  // It is an explicit user choice; reusing whatever this box has running would silently ignore
  // it, which is the same class of bug as auto-loading something else.
  const { calls, fn } = makeSpawn()
  const hits: Hits = { engineStart: 0, gatewayModels: 0 }
  const out = silenceOutput()
  try {
    const code = await launchCli(
      'claude', 6996, [], fn,
      undefined,
      makeFetch(['qwen3-8b', 'workstation/Qwen3-35B'], hits, 'running', 'workstation/Qwen3-35B'),
    )
    assert.equal(code, 0)
    assert.equal(calls[0].env['ANTHROPIC_MODEL'], 'workstation/Qwen3-35B')
    assert.equal(hits.engineStart, 0)
  } finally {
    out.restore()
  }
})

test('a STALE selection (its machine went offline) falls back to the local path', async () => {
  // Re-validated against what the gateway advertises RIGHT NOW rather than trusted from
  // config — otherwise a link that dropped would pin the CLI to a machine that cannot answer.
  const { calls, fn } = makeSpawn()
  const hits: Hits = { engineStart: 0, gatewayModels: 0 }
  const out = silenceOutput()
  try {
    const code = await launchCli(
      'claude', 6996, [], fn,
      undefined,
      makeFetch(['qwen3-8b'], hits, 'running', 'workstation/Qwen3-35B'),
    )
    assert.equal(code, 0)
    assert.equal(calls[0].env['ANTHROPIC_MODEL'], 'qwen3-8b', 'falls back to the loaded local model')
  } finally {
    out.restore()
  }
})
