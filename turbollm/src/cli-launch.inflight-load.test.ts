// AC11 (G2-A): with auto-load on, `turbollm launch` in a second terminal usually arrives while the
// daemon is still loading the model it resumed at boot. The launcher must wait for that load instead
// of POSTing the same model again (which stops the in-flight load and starts over). Every other engine
// state must still POST exactly as it did at 4fa0f7b; the guards below pin that.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { EventEmitter } from 'node:events'
import { launchCli, type ConfigFs } from './cli-launch.js'

// Keeps launchCli's (unrelated) MCP config write off the disk.
const NO_OP_FS: ConfigFs = {
  home: '/unused',
  readFile: async () => { throw new Error('not used by this test file') },
  writeFile: async () => { throw new Error('not used by this test file') },
  mkdir: async () => { throw new Error('not used by this test file') },
}

const MODELS = [
  { key: 'qwen3-8b', name: 'Qwen3 8B' },
  { key: 'llama-3-70b', name: 'Llama 3 70B' },
]

type EngineState = 'starting' | 'running' | 'stopping' | 'stopped' | 'error'

interface DaemonSetup {
  state: EngineState
  key: string | null
  lastLoaded: string | null
  settleTo?: 'running' | 'error'
  settleAfterPolls?: number
}

interface FakeDaemon {
  fetch: typeof fetch
  /** The modelKey of every POST to /api/v1/engine/start, in order. */
  starts: string[]
}

interface CapturedSpawn {
  cmd: string
  args: string[]
  env: Record<string, string | undefined>
}

interface LaunchOutcome {
  code: number
  spawns: CapturedSpawn[]
  banners: string[]
  stderr: string
}

test('AC11: an auto-selected model the daemon is already loading is waited for, not loaded again', async () => {
  const daemon = fakeDaemon({ state: 'starting', key: MODELS[1].key, lastLoaded: MODELS[1].key })

  const outcome = await launchClaude(daemon)

  assert.deepEqual(daemon.starts, [])
  assert.equal(outcome.code, 0)
  assert.equal(outcome.spawns.length, 1)
  assert.equal(outcome.spawns[0].env.ANTHROPIC_MODEL, MODELS[1].key)
})

test('AC11: a --model target the daemon is already loading is waited for, not loaded again', async () => {
  const daemon = fakeDaemon({ state: 'starting', key: MODELS[1].key, lastLoaded: MODELS[1].key })

  const outcome = await launchClaude(daemon, 'Llama 3 70B')

  assert.deepEqual(daemon.starts, [])
  assert.equal(outcome.code, 0)
})

test('AC11: when the in-flight load fails, launch exits 1 with the 180 s message and sends no load', async () => {
  const daemon = fakeDaemon({ state: 'starting', key: MODELS[1].key, lastLoaded: MODELS[1].key, settleTo: 'error' })

  const outcome = await launchClaude(daemon)

  assert.deepEqual(daemon.starts, [])
  assert.equal(outcome.code, 1)
  assert.match(outcome.stderr, /did not finish loading within 180 s/)
})

test('unchanged: a different model starting still gets its own load request', async () => {
  const daemon = fakeDaemon({ state: 'starting', key: MODELS[0].key, lastLoaded: MODELS[1].key })

  const outcome = await launchClaude(daemon)

  assert.deepEqual(daemon.starts, [MODELS[1].key])
  assert.equal(outcome.code, 0)
})

test('unchanged: a stopped engine still gets a load request', async () => {
  const daemon = fakeDaemon({ state: 'stopped', key: null, lastLoaded: MODELS[1].key })

  await launchClaude(daemon)

  assert.deepEqual(daemon.starts, [MODELS[1].key])
})

test('unchanged: an errored engine still gets a load request', async () => {
  const daemon = fakeDaemon({ state: 'error', key: null, lastLoaded: MODELS[1].key })

  await launchClaude(daemon)

  assert.deepEqual(daemon.starts, [MODELS[1].key])
})

test('waiting for an in-flight load prints one waiting banner and no loading banner', async () => {
  const daemon = fakeDaemon({ state: 'starting', key: MODELS[1].key, lastLoaded: MODELS[1].key })

  const { banners } = await launchClaude(daemon)

  const waiting = banners.filter((b) => b.startsWith('▸ Waiting for model "llama-3-70b" to finish loading'))
  assert.equal(waiting.length, 1)
  assert.deepEqual(banners.filter((b) => b.includes('Auto-loading model') || b.includes('Loading model')), [])
})

test('unchanged: a stopping engine gets a load request even for the auto-selected model', async () => {
  const daemon = fakeDaemon({ state: 'stopping', key: MODELS[1].key, lastLoaded: MODELS[1].key })

  const outcome = await launchClaude(daemon)

  assert.deepEqual(daemon.starts, [MODELS[1].key])
  assert.equal(outcome.code, 0)
})

test('unchanged: a stopping engine gets a load request even for the --model target', async () => {
  const daemon = fakeDaemon({ state: 'stopping', key: MODELS[1].key, lastLoaded: MODELS[1].key })

  const outcome = await launchClaude(daemon, 'Llama 3 70B')

  assert.deepEqual(daemon.starts, [MODELS[1].key])
  assert.equal(outcome.code, 0)
})

async function launchClaude(daemon: FakeDaemon, modelFlag?: string): Promise<LaunchOutcome> {
  const { calls, fn } = makeSpawn()
  const output = recordOutput()
  try {
    const code = await launchCli('claude', 6996, [], fn, modelFlag, daemon.fetch, undefined, NO_OP_FS)
    return { code, spawns: calls, banners: output.banners, stderr: output.stderr() }
  } finally {
    output.restore()
  }
}

/** A daemon whose engine can be mid-load. The launcher's first /status read is not counted; every later
 *  read counts down `settleAfterPolls`, and at 0 the engine becomes `settleTo`. /status carries `model`
 *  only while `starting` or `running`, like the real Manager.status() (engines/manager.ts). A POST to
 *  /engine/start loads the requested model at once and cancels any pending settle. */
function fakeDaemon(setup: DaemonSetup): FakeDaemon {
  const { lastLoaded, settleTo = 'running', settleAfterPolls = 1 } = setup
  let { state, key } = setup
  let pollsBeforeSettle: number | null = settleAfterPolls
  let launcherHasReadStatus = false
  const starts: string[] = []

  const statusBody = () => ({
    engine: { state },
    model: (state === 'starting' || state === 'running') && key ? { key, name: key } : null,
    lastLoaded: lastLoaded ? { modelKey: lastLoaded } : null,
    selectedRemoteModel: '',
  })

  const countStatusRead = () => {
    if (!launcherHasReadStatus) {
      launcherHasReadStatus = true
      return
    }
    if (pollsBeforeSettle === null) return
    pollsBeforeSettle -= 1
    if (pollsBeforeSettle > 0) return
    state = settleTo
    pollsBeforeSettle = null
  }

  const startLoad = (modelKey: string) => {
    starts.push(modelKey)
    key = modelKey
    state = 'running'
    pollsBeforeSettle = null
  }

  const serve = async (input: string | URL | globalThis.Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    if (url.includes('/api/v1/status')) {
      countStatusRead()
      return jsonResponse(200, statusBody())
    }
    if (url.includes('/api/v1/models')) return jsonResponse(200, { models: MODELS })
    if (url.includes('/api/v1/engine/start')) {
      startLoad(requestedModelKey(init))
      return jsonResponse(202, { ok: true })
    }
    return jsonResponse(404, {})
  }
  return { fetch: serve as unknown as typeof fetch, starts }
}

function requestedModelKey(init?: RequestInit): string {
  const parsed = JSON.parse(init?.body?.toString() ?? '{}') as { modelKey?: string }
  return parsed.modelKey ?? ''
}

function jsonResponse(status: number, body: unknown): Response {
  return { ok: status < 400, status, json: async () => body } as Response
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

/** Record launchCli's own output WITHOUT eating node:test's results. Its stdout banners all start with
 *  '▸', so exactly those are recorded and swallowed, and every other stdout chunk is forwarded: under
 *  the full suite stdout is the channel the runner parses (see silenceOutput in
 *  cli-launch.model.test.ts). stderr is not that channel, so it is recorded and swallowed whole. */
function recordOutput(): { banners: string[]; stderr: () => string; restore: () => void } {
  const outW = process.stdout.write.bind(process.stdout)
  const errW = process.stderr.write.bind(process.stderr)
  const banners: string[] = []
  let stderr = ''
  process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
    if (!String(chunk).startsWith('▸')) return (outW as (...a: unknown[]) => boolean)(chunk, ...rest)
    banners.push(String(chunk))
    return true
  }) as typeof process.stdout.write
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr += String(chunk)
    return true
  }) as typeof process.stderr.write
  const restore = () => {
    process.stdout.write = outW
    process.stderr.write = errW
  }
  return { banners, stderr: () => stderr, restore }
}
