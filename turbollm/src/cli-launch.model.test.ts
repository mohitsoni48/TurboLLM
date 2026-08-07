// Unit tests for F-034: --model resolution + auto-load in launchCli.
// Uses the injected _spawn and _fetch hooks (same pattern as cli-launch.timeout.test.ts).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { EventEmitter } from 'node:events'
import { launchCli, clampAutoCompactWindow } from './cli-launch.js'

// ── Helpers ───────────────────────────────────────────────────────────────────

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

/** Silence launchCli's own banner output during a call, WITHOUT eating node:test's results.
 *
 *  This used to no-op process.stdout.write wholesale. Under the full suite stdout is the
 *  V8-serialized channel the parent runner parses, and the reporter emits each test's result on a
 *  later tick — by which point the NEXT test had already installed its no-op, so the write went
 *  nowhere. This file has 12 tests and the runner counted 1. Measured, so the risk isn't
 *  overstated: a deliberately failing test under the old helper still surfaced (`fail 1`), so this
 *  was not silent-green. What it did lose was the file's own reported coverage — 11 of 12 results
 *  dropped, which is what makes a whole file quietly stop pulling its weight.
 *
 *  launchCli's stdout writes all begin with '▸' (four call sites, cli-launch.ts), so swallowing
 *  exactly those and forwarding everything else keeps the channel intact. stderr is not the
 *  result channel, so it can still be dropped wholesale. */
function silenceOutput(): () => void {
  const outW = process.stdout.write.bind(process.stdout)
  const errW = process.stderr.write.bind(process.stderr)
  process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
    if (String(chunk).startsWith('▸')) return true
    return (outW as (...a: unknown[]) => boolean)(chunk, ...rest)
  }) as typeof process.stdout.write
  process.stderr.write = (() => true) as typeof process.stderr.write
  return () => {
    process.stdout.write = outW
    process.stderr.write = errW
  }
}

const MODELS = [
  { key: 'qwen3-8b', name: 'Qwen3 8B' },
  { key: 'llama-3-70b', name: 'Llama 3 70B' },
]

/**
 * Build a fake fetch that responds to status, models, and engine/start.
 *
 * `initialState`:
 *   - 'running' → status already has model loaded (key = modelKey)
 *   - 'idle'    → no model loaded; after a POST to /engine/start the next status
 *                 poll returns running with the requested model key.
 */
function makeFetch(
  initialState: 'running' | 'idle',
  loadedKey = MODELS[0].key,
): typeof fetch {
  let runningKey: string | null = initialState === 'running' ? loadedKey : null
  const fn = async (input: string | URL | globalThis.Request, _init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url

    if (url.includes('/api/v1/status')) {
      const body =
        runningKey !== null
          ? { engine: { state: 'running' }, model: { key: runningKey, name: runningKey } }
          : { engine: { state: 'idle' }, model: null }
      return { ok: true, status: 200, json: async () => body } as Response
    }

    if (url.includes('/api/v1/models')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ models: MODELS }),
      } as Response
    }

    if (url.includes('/api/v1/engine/start')) {
      const text = await _init?.body?.toString()
      let key = loadedKey
      try {
        const parsed = JSON.parse(text ?? '{}') as { modelKey?: string }
        if (parsed.modelKey) key = parsed.modelKey
      } catch { /* ignore */ }
      // Simulate async load: the very next status poll returns running.
      runningKey = key
      return { ok: true, status: 202, json: async () => ({ ok: true }) } as Response
    }

    return { ok: false, status: 404, json: async () => ({}) } as Response
  }
  return fn as unknown as typeof fetch
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test('launchCli already-loaded model: spawns without calling engine/start', async () => {
  const { calls, fn } = makeSpawn()
  const unsilence = silenceOutput()
  try {
    const code = await launchCli(
      'claude', 6996, [], fn,
      undefined, // no --model flag
      makeFetch('running', MODELS[0].key),
    )
    assert.equal(code, 0)
    assert.equal(calls.length, 1, 'spawn should be called once')
  } finally {
    unsilence()
  }
})

test('launchCli --model exact key: loads matching model and launches', async () => {
  const { calls, fn } = makeSpawn()
  const unsilence = silenceOutput()
  try {
    const code = await launchCli(
      'claude', 6996, [], fn,
      'llama-3-70b', // exact key of second model
      makeFetch('idle'),
    )
    assert.equal(code, 0)
    assert.equal(calls.length, 1)
    // The model name passed as ANTHROPIC_MODEL should correspond to the loaded key.
    assert.equal(calls[0].env['ANTHROPIC_MODEL'], 'llama-3-70b')
  } finally {
    unsilence()
  }
})

test('launchCli --model exact name: resolves by name and launches', async () => {
  const { calls, fn } = makeSpawn()
  const unsilence = silenceOutput()
  try {
    const code = await launchCli(
      'claude', 6996, [], fn,
      'Llama 3 70B', // exact name of second model
      makeFetch('idle'),
    )
    assert.equal(code, 0)
    assert.equal(calls.length, 1)
  } finally {
    unsilence()
  }
})

test('launchCli --model partial case-insensitive name: resolves and launches', async () => {
  const { calls, fn } = makeSpawn()
  const unsilence = silenceOutput()
  try {
    const code = await launchCli(
      'claude', 6996, [], fn,
      'qwen3', // partial, case-insensitive match of "Qwen3 8B"
      makeFetch('idle'),
    )
    assert.equal(code, 0)
    assert.equal(calls.length, 1)
  } finally {
    unsilence()
  }
})

test('launchCli --model not found: prints error listing models, returns 1', async () => {
  const { fn } = makeSpawn()
  let stderrOutput = ''
  const origWrite = process.stderr.write.bind(process.stderr)
  process.stderr.write = ((s: string) => { stderrOutput += s; return true }) as typeof process.stderr.write
  const origOut = process.stdout.write.bind(process.stdout)
  process.stdout.write = (() => true) as typeof process.stdout.write
  try {
    const code = await launchCli(
      'claude', 6996, [], fn,
      'nonexistent-model-xyz',
      makeFetch('idle'),
    )
    assert.equal(code, 1)
    assert.match(stderrOutput, /not found/i)
    assert.match(stderrOutput, /qwen3-8b/)
  } finally {
    process.stderr.write = origWrite
    process.stdout.write = origOut
  }
})

test('launchCli auto-load when no model loaded: loads first model and launches', async () => {
  const { calls, fn } = makeSpawn()
  const unsilence = silenceOutput()
  try {
    const code = await launchCli(
      'claude', 6996, [], fn,
      undefined, // no --model
      makeFetch('idle'),
    )
    assert.equal(code, 0)
    assert.equal(calls.length, 1, 'spawn should be called once after auto-load')
  } finally {
    unsilence()
  }
})

test('launchCli auto-load prefers lastLoaded.modelKey over the first library model', async () => {
  const { calls, fn } = makeSpawn()
  const unsilence = silenceOutput()
  // lastLoaded points at the SECOND model; auto-load must pick it, not models[0].
  let runningKey: string | null = null
  let startedKey: string | null = null
  const lastUsedFetch: typeof fetch = (async (input: string | URL | globalThis.Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as globalThis.Request).url
    if (url.includes('/api/v1/status')) {
      const body =
        runningKey !== null
          ? { engine: { state: 'running' }, model: { key: runningKey, name: runningKey }, lastLoaded: { modelKey: MODELS[1].key } }
          : { engine: { state: 'idle' }, model: null, lastLoaded: { modelKey: MODELS[1].key } }
      return { ok: true, status: 200, json: async () => body } as Response
    }
    if (url.includes('/api/v1/models')) {
      return { ok: true, status: 200, json: async () => ({ models: MODELS }) } as Response
    }
    if (url.includes('/api/v1/engine/start')) {
      const parsed = JSON.parse((await init?.body?.toString()) ?? '{}') as { modelKey?: string }
      startedKey = parsed.modelKey ?? null
      runningKey = startedKey
      return { ok: true, status: 202, json: async () => ({ ok: true }) } as Response
    }
    return { ok: false, status: 404, json: async () => ({}) } as Response
  }) as unknown as typeof fetch
  try {
    const code = await launchCli('claude', 6996, [], fn, undefined, lastUsedFetch)
    assert.equal(code, 0)
    assert.equal(startedKey, MODELS[1].key, 'should auto-load the last-used model, not the first')
    // We always pin ANTHROPIC_MODEL to the loaded model's key — even without --model.
    assert.equal(calls[0].env['ANTHROPIC_MODEL'], MODELS[1].key)
  } finally {
    unsilence()
  }
})

test('launchCli auto-load with empty library: returns 1 with friendly message', async () => {
  const { fn } = makeSpawn()
  let stderrOutput = ''
  const origWrite = process.stderr.write.bind(process.stderr)
  process.stderr.write = ((s: string) => { stderrOutput += s; return true }) as typeof process.stderr.write
  const origOut = process.stdout.write.bind(process.stdout)
  process.stdout.write = (() => true) as typeof process.stdout.write

  const emptyFetch: typeof fetch = (async (input: string | URL | globalThis.Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as globalThis.Request).url
    if (url.includes('/api/v1/status')) {
      return { ok: true, status: 200, json: async () => ({ engine: { state: 'idle' }, model: null }) } as Response
    }
    if (url.includes('/api/v1/models')) {
      return { ok: true, status: 200, json: async () => ({ models: [] }) } as Response
    }
    return { ok: false, status: 404, json: async () => ({}) } as Response
  }) as unknown as typeof fetch

  try {
    const code = await launchCli('claude', 6996, [], fn, undefined, emptyFetch)
    assert.equal(code, 1)
    assert.match(stderrOutput, /no model is loaded and no models are in the library/i)
  } finally {
    process.stderr.write = origWrite
    process.stdout.write = origOut
  }
})

test('launchCli --model already loaded with same key: skips load and launches', async () => {
  const { calls, fn } = makeSpawn()
  const unsilence = silenceOutput()

  // Track engine/start calls
  let startCalls = 0
  const trackingFetch: typeof fetch = (async (input: string | URL | globalThis.Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as globalThis.Request).url
    if (url.includes('/api/v1/engine/start')) {
      startCalls++
    }
    return makeFetch('running', MODELS[0].key)(input, init)
  }) as unknown as typeof fetch

  try {
    const code = await launchCli(
      'claude', 6996, [], fn,
      MODELS[0].key, // --model same as currently loaded
      trackingFetch,
    )
    assert.equal(code, 0)
    assert.equal(startCalls, 0, 'engine/start should NOT be called when model already loaded')
    assert.equal(calls.length, 1)
  } finally {
    unsilence()
  }
})

test('launchCli without --model: pins ANTHROPIC_MODEL to the loaded model key', async () => {
  const { calls, fn } = makeSpawn()
  const unsilence = silenceOutput()
  try {
    const code = await launchCli(
      'claude', 6996, [], fn,
      undefined, // no --model flag
      makeFetch('running', MODELS[0].key),
    )
    assert.equal(code, 0)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].env['ANTHROPIC_MODEL'], MODELS[0].key, 'ANTHROPIC_MODEL must be pinned to the loaded key')
    // The rest of the gateway wiring is still applied.
    assert.equal(calls[0].env['ANTHROPIC_BASE_URL'], 'http://127.0.0.1:6996')
    assert.equal(calls[0].env['ANTHROPIC_AUTH_TOKEN'], 'turbollm-local')
    assert.equal(calls[0].env['CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY'], '1')
  } finally {
    unsilence()
  }
})

test('launchCli prefers the model key over its display name for ANTHROPIC_MODEL', async () => {
  const { calls, fn } = makeSpawn()
  const unsilence = silenceOutput()
  // Status reports a distinct key + display name; the key must win.
  const keyVsName: typeof fetch = (async (input: string | URL | globalThis.Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as globalThis.Request).url
    if (url.includes('/api/v1/status')) {
      return { ok: true, status: 200, json: async () => ({ engine: { state: 'running' }, model: { key: 'qwen3-8b', name: 'Qwen3 8B' } }) } as Response
    }
    return { ok: false, status: 404, json: async () => ({}) } as Response
  }) as unknown as typeof fetch
  try {
    const code = await launchCli('claude', 6996, [], fn, undefined, keyVsName)
    assert.equal(code, 0)
    assert.equal(calls[0].env['ANTHROPIC_MODEL'], 'qwen3-8b', 'the key, not the display name, must be pinned')
  } finally {
    unsilence()
  }
})

test('launchCli with --model: pins ANTHROPIC_MODEL to the resolved model', async () => {
  const { calls, fn } = makeSpawn()
  const unsilence = silenceOutput()
  try {
    const code = await launchCli(
      'claude', 6996, [], fn,
      MODELS[0].key, // explicit --model
      makeFetch('running', MODELS[0].key),
    )
    assert.equal(code, 0)
    assert.equal(calls[0].env['ANTHROPIC_MODEL'], MODELS[0].key, '--model must pin ANTHROPIC_MODEL')
  } finally {
    unsilence()
  }
})

// ── engine slot count → the CLI's own background-agent cap ────────────────────────────────────
// Claude Code fans out subagents in parallel and each is a full, independent gateway request.
// Against a `--parallel 1` llama-server they don't merely queue — they evict each other's cached
// prompt prefix, so every one re-prefills from scratch, and each holds a connection against
// ANTHROPIC_TIMEOUT. Telling the CLI the real number lets IT queue the excess. The gateway
// enforces the same ceiling independently, so this is the cooperative half, not the only guard.

/** A status fetch that reports an engine slot count, which the real /api/v1/status now includes. */
function fetchWithSlots(slots: number | undefined): typeof fetch {
  const fn = async (input: string | URL | globalThis.Request): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    if (url.includes('/api/v1/status')) {
      const engine: Record<string, unknown> = { state: 'running' }
      if (slots !== undefined) engine.parallelSlots = slots
      return {
        ok: true, status: 200,
        json: async () => ({ engine, model: { key: MODELS[0].key, name: MODELS[0].name } }),
      } as Response
    }
    return { ok: false, status: 404, json: async () => ({}) } as Response
  }
  return fn as unknown as typeof fetch
}

test('launchCli caps concurrent subagents at the engine\'s slot count', async () => {
  const { calls, fn } = makeSpawn()
  const unsilence = silenceOutput()
  try {
    await launchCli('claude', 6996, [], fn, undefined, fetchWithSlots(1))
    assert.equal(calls[0].env['CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS'], '1')
  } finally {
    unsilence()
  }
})

test('launchCli passes a multi-slot engine\'s real capacity through, not a hardcoded 1', async () => {
  const { calls, fn } = makeSpawn()
  const unsilence = silenceOutput()
  try {
    await launchCli('claude', 6996, [], fn, undefined, fetchWithSlots(4))
    assert.equal(calls[0].env['CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS'], '4')
  } finally {
    unsilence()
  }
})

test('launchCli sets NO cap when the engine advertises no slot count', async () => {
  // vLLM / mlx-lm do their own continuous batching. Setting 1 here because we couldn't read a
  // flag would be a brand-new restriction on those engines dressed up as a fix — the CLI must
  // keep its own default instead.
  const { calls, fn } = makeSpawn()
  const unsilence = silenceOutput()
  try {
    await launchCli('claude', 6996, [], fn, undefined, fetchWithSlots(undefined))
    assert.equal(calls[0].env['CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS'], undefined)
  } finally {
    unsilence()
  }
})

// ── CLAUDE_CODE_AUTO_COMPACT_WINDOW / CLAUDE_AUTOCOMPACT_PCT_OVERRIDE ──────────────────────────
// Founder-reported: the terminal-agent `claude` CLI "never auto-compacts at 80%, always reaches
// 100% and fails". Root cause (Claude Code's own docs, code-window#set-the-auto-compact-window):
// with no override, the CLI compacts only once the conversation nears "the model's context
// limit" — its OWN generic ~200K assumption for an unrecognized model, not the real, often much
// smaller local ctx. Pinning CLAUDE_CODE_AUTO_COMPACT_WINDOW to the real loaded ctx (clamped to
// the CLI's own documented [100_000, 1_000_000] range) fixes this for ctx >= 100K and tightens
// the over-generous default below that; CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=80 matches this
// codebase's own established 80%-of-window convention (ADR-132).

test('clampAutoCompactWindow: passes a value already inside the documented range through unchanged', () => {
  assert.equal(clampAutoCompactWindow(200_000), 200_000)
})

test('clampAutoCompactWindow: floors at 100_000 for a small local context (e.g. 8K/32K)', () => {
  assert.equal(clampAutoCompactWindow(8192), 100_000)
  assert.equal(clampAutoCompactWindow(32768), 100_000)
})

test('clampAutoCompactWindow: ceilings at 1_000_000 for a very large context', () => {
  assert.equal(clampAutoCompactWindow(2_000_000), 1_000_000)
})

test('clampAutoCompactWindow: rounds a non-integer ctx to the nearest whole token count', () => {
  assert.equal(clampAutoCompactWindow(131_072.4), 131_072)
})

/** A status fetch that reports a real loaded-model ctx, mirroring fetchWithSlots above. */
function fetchWithCtx(ctx: number | undefined): typeof fetch {
  const fn = async (input: string | URL | globalThis.Request): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    if (url.includes('/api/v1/status')) {
      const model: Record<string, unknown> = { key: MODELS[0].key, name: MODELS[0].name }
      if (ctx !== undefined) model.ctx = ctx
      return {
        ok: true, status: 200,
        json: async () => ({ engine: { state: 'running' }, model }),
      } as Response
    }
    return { ok: false, status: 404, json: async () => ({}) } as Response
  }
  return fn as unknown as typeof fetch
}

test('launchCli pins CLAUDE_CODE_AUTO_COMPACT_WINDOW to the real loaded ctx and sets the 80% override', async () => {
  const { calls, fn } = makeSpawn()
  const unsilence = silenceOutput()
  try {
    await launchCli('claude', 6996, [], fn, undefined, fetchWithCtx(200_000))
    assert.equal(calls[0].env['CLAUDE_CODE_AUTO_COMPACT_WINDOW'], '200000')
    assert.equal(calls[0].env['CLAUDE_AUTOCOMPACT_PCT_OVERRIDE'], '80')
  } finally {
    unsilence()
  }
})

test('launchCli clamps CLAUDE_CODE_AUTO_COMPACT_WINDOW to the CLI-documented 100_000 floor for a small local ctx', async () => {
  const { calls, fn } = makeSpawn()
  const unsilence = silenceOutput()
  try {
    await launchCli('claude', 6996, [], fn, undefined, fetchWithCtx(8192))
    assert.equal(calls[0].env['CLAUDE_CODE_AUTO_COMPACT_WINDOW'], '100000')
  } finally {
    unsilence()
  }
})

test('launchCli sets NO CLAUDE_CODE_AUTO_COMPACT_WINDOW when the daemon reports no real ctx', async () => {
  // Absent/zero ctx means "don't know" — guessing a window here would be worse than leaving the
  // CLI's own generic default in place.
  const { calls, fn } = makeSpawn()
  const unsilence = silenceOutput()
  try {
    await launchCli('claude', 6996, [], fn, undefined, fetchWithCtx(undefined))
    assert.equal(calls[0].env['CLAUDE_CODE_AUTO_COMPACT_WINDOW'], undefined)
    // The 80% override is independent of knowing ctx — it only ever lowers the CLI's own
    // threshold within whatever window it ends up using, so it's always safe to set.
    assert.equal(calls[0].env['CLAUDE_AUTOCOMPACT_PCT_OVERRIDE'], '80')
  } finally {
    unsilence()
  }
})
