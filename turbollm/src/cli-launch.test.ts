// A coding agent needs a chat model: a Jev model labels text and cannot hold a conversation
// (ADR-434 (f)). `turbollm launch` must never pick one — not by `--model`, not by auto-load, and
// not by writing it into a harness's own model picker. Injected `_spawn`/`_fetch`/`_mcpFs` only:
// no process, no network, no port.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { EventEmitter } from 'node:events'
import { join } from 'node:path'
import { launchCli, type ConfigFs } from './cli-launch.js'

const JEV = { key: 'jev-fake-v2', name: 'jev fake v2', jev: { labels: ['contradiction', 'entailment', 'neutral'], architecture: 'Qwen3_5ForSequenceClassification', verified: true } }
const CHAT = { key: 'qwen3-8b', name: 'Qwen3 8B' }
const HOME = '/home/tester'

function makeSpawn(): { calls: number; envs: Array<Record<string, string | undefined>>; fn: Parameters<typeof launchCli>[3] } {
  const state = { calls: 0 }
  const envs: Array<Record<string, string | undefined>> = []
  const fn: Parameters<typeof launchCli>[3] = (_cmd, _args, opts) => {
    state.calls++
    envs.push((opts?.env ?? {}) as Record<string, string | undefined>)
    const ee = new EventEmitter() as ReturnType<typeof import('node:child_process').spawn>
    setImmediate(() => ee.emit('exit', 0, null))
    return ee
  }
  return { get calls() { return state.calls }, envs, fn }
}

interface FakeDaemon {
  fetch: typeof fetch
  /** Every model key a load was requested for. */
  loads: string[]
  /** Every URL the launcher asked for, in order. */
  requests: string[]
}

interface DaemonOptions {
  /** What `/api/v1/status` reports as `jev`. Left out, the daemon looks like one that predates the field. */
  jev?: Record<string, unknown> | null
  /** The library listing (`/api/v1/models`) fails, as it does for a daemon caught mid-rescan. */
  libraryFails?: boolean
}

const JEV_STATUS = { key: JEV.key, name: JEV.name, labels: JEV.jev.labels, state: 'running', slot: 'primary' }

/** A daemon with both models in the library and `lastLoaded` as given. Nothing is loaded unless
 *  `loadedKey` names the model that is already running when the launcher connects. */
function fakeDaemon(lastLoadedKey?: string, loadedKey: string | null = null, options: DaemonOptions = {}): FakeDaemon {
  const loads: string[] = []
  const requests: string[] = []
  let runningKey: string | null = loadedKey
  const fetchImpl = async (input: string | URL | globalThis.Request, init?: RequestInit): Promise<Response> => {
    const url = String(input)
    requests.push(url)
    if (url.includes('/api/v1/status')) {
      const body = runningKey
        ? { engine: { state: 'running' }, model: { key: runningKey, name: runningKey } }
        : { engine: { state: 'idle' }, model: null, ...(lastLoadedKey ? { lastLoaded: { modelKey: lastLoadedKey } } : {}) }
      const reported = options.jev === undefined ? body : { ...body, jev: options.jev }
      return { ok: true, status: 200, json: async () => reported } as Response
    }
    if (url.includes('/api/v1/models')) {
      if (options.libraryFails) throw new Error('read ECONNRESET')
      return { ok: true, status: 200, json: async () => ({ models: [JEV, CHAT] }) } as Response
    }
    if (url.includes('/api/v1/engine/start')) {
      const parsed = JSON.parse(String(init?.body ?? '{}')) as { modelKey?: string }
      if (parsed.modelKey) { loads.push(parsed.modelKey); runningKey = parsed.modelKey }
      return { ok: true, status: 202, json: async () => ({ ok: true }) } as Response
    }
    return { ok: false, status: 404, json: async () => ({}) } as Response
  }
  return { fetch: fetchImpl as unknown as typeof fetch, loads, requests }
}

/** In-memory ConfigFs, as cli-launch.config.test.ts uses. */
function memFs(): ConfigFs & { files: Map<string, string> } {
  const files = new Map<string, string>()
  return {
    files,
    home: HOME,
    readFile: async (p: string) => {
      if (!files.has(p)) throw new Error('ENOENT')
      return files.get(p)!
    },
    writeFile: async (p: string, data: string) => { files.set(p, data) },
    mkdir: async () => {},
  }
}

/** Captures stderr while keeping node:test's own stdout channel intact (launchCli's banner
 *  lines all start with '▸'). */
async function captured(fn: () => Promise<number>): Promise<{ code: number; stderr: string }> {
  const outW = process.stdout.write.bind(process.stdout)
  const errW = process.stderr.write.bind(process.stderr)
  let stderr = ''
  process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
    if (String(chunk).startsWith('▸')) return true
    return (outW as (...a: unknown[]) => boolean)(chunk, ...rest)
  }) as typeof process.stdout.write
  process.stderr.write = ((chunk: string) => { stderr += String(chunk); return true }) as typeof process.stderr.write
  try {
    return { code: await fn(), stderr }
  } finally {
    process.stdout.write = outW
    process.stderr.write = errW
  }
}

test('--model naming a Jev model refuses with a clear reason and loads nothing', async () => {
  const spawn = makeSpawn()
  const daemon = fakeDaemon()

  const { code, stderr } = await captured(() => launchCli('claude', 6996, [], spawn.fn, 'jev-fake-v2', daemon.fetch))

  assert.equal(code, 1)
  assert.equal(stderr, `'jev fake v2' is a Jev model (it labels text) — coding agents need a chat model.\n`)
  assert.deepEqual(daemon.loads, [], 'nothing may be loaded')
  assert.equal(spawn.calls, 0, 'the agent must not be launched')
})

test('--model naming a Jev model by NAME is refused too', async () => {
  const daemon = fakeDaemon()

  const { code, stderr } = await captured(() => launchCli('claude', 6996, [], makeSpawn().fn, 'jev fake v2', daemon.fetch))

  assert.equal(code, 1)
  assert.match(stderr, /is a Jev model/)
  assert.deepEqual(daemon.loads, [])
})

test('auto-load skips a Jev model even when it was the last one loaded', async () => {
  const spawn = makeSpawn()
  const daemon = fakeDaemon('jev-fake-v2')

  const { code } = await captured(() => launchCli('claude', 6996, [], spawn.fn, undefined, daemon.fetch))

  assert.equal(code, 0)
  assert.deepEqual(daemon.loads, ['qwen3-8b'], 'the chat model is loaded, never the Jev one')
  assert.equal(spawn.calls, 1)
})

test('no --model, with a Jev model already loaded, refuses instead of pinning the agent to it', async () => {
  const spawn = makeSpawn()
  const daemon = fakeDaemon(undefined, 'jev-fake-v2')

  const { code, stderr } = await captured(() => launchCli('claude', 6996, [], spawn.fn, undefined, daemon.fetch, undefined, memFs()))

  assert.equal(code, 1)
  assert.equal(stderr, `'jev fake v2' is a Jev model (it labels text) — coding agents need a chat model.
`)
  assert.deepEqual(daemon.loads, [], 'nothing may be loaded')
  assert.equal(spawn.calls, 0, 'the agent must not be launched')
})

test('a config-writing harness is not wired to an already-loaded Jev model either', async () => {
  const fs = memFs()
  const daemon = fakeDaemon(undefined, 'jev-fake-v2')

  const { code } = await captured(() => launchCli('opencode', 6996, [], makeSpawn().fn, undefined, daemon.fetch, undefined, fs))

  assert.equal(code, 1)
  assert.equal(fs.files.size, 0, 'no harness config may be written for a Jev model')
})

test('no --model, with a chat model already loaded, still reuses it without loading anything', async () => {
  const spawn = makeSpawn()
  const daemon = fakeDaemon(undefined, 'qwen3-8b')

  const { code } = await captured(() => launchCli('claude', 6996, [], spawn.fn, undefined, daemon.fetch, undefined, memFs()))

  assert.equal(code, 0)
  assert.deepEqual(daemon.loads, [])
  assert.equal(spawn.calls, 1)
})

test('a config-writing harness never advertises a Jev model in its own picker', async () => {
  const fs = memFs()
  const daemon = fakeDaemon()

  const { code } = await captured(() => launchCli('opencode', 6996, [], makeSpawn().fn, 'qwen3-8b', daemon.fetch, undefined, fs))

  assert.equal(code, 0)
  const cfg = JSON.parse(fs.files.get(join(HOME, '.config', 'opencode', 'opencode.json')) ?? '{}') as {
    provider: { turbollm: { models: Record<string, unknown> } }
  }
  assert.deepEqual(Object.keys(cfg.provider.turbollm.models), ['qwen3-8b'])
})

test('--model naming a chat model is unaffected', async () => {
  const spawn = makeSpawn()
  const daemon = fakeDaemon()

  const { code } = await captured(() => launchCli('claude', 6996, [], spawn.fn, 'qwen3-8b', daemon.fetch))

  assert.equal(code, 0)
  assert.deepEqual(daemon.loads, ['qwen3-8b'])
  assert.equal(spawn.calls, 1)
})

const JEV_REFUSAL = `'jev fake v2' is a Jev model (it labels text) — coding agents need a chat model.\n`
const LIBRARY_LISTING = '/api/v1/models'

test('a loaded Jev model is refused on the daemon\'s own report, even when the library cannot be listed', async () => {
  const spawn = makeSpawn()
  const daemon = fakeDaemon(undefined, 'jev-fake-v2', { jev: JEV_STATUS, libraryFails: true })

  const { code, stderr } = await captured(() => launchCli('claude', 6996, [], spawn.fn, undefined, daemon.fetch, undefined, memFs()))

  assert.equal(code, 1)
  assert.equal(stderr, JEV_REFUSAL)
  assert.deepEqual(daemon.loads, [], 'nothing may be loaded')
  assert.equal(spawn.calls, 0, 'the agent must not be launched')
})

test('a loaded Jev model is refused without asking the daemon for the library at all', async () => {
  const daemon = fakeDaemon(undefined, 'jev-fake-v2', { jev: JEV_STATUS })

  const { code, stderr } = await captured(() => launchCli('claude', 6996, [], makeSpawn().fn, undefined, daemon.fetch, undefined, memFs()))

  assert.equal(code, 1)
  assert.equal(stderr, JEV_REFUSAL)
  assert.equal(daemon.requests.some((url) => url.includes(LIBRARY_LISTING)), false, 'the status already answers it')
})

test('a config-writing harness is not wired to a loaded Jev model when the library cannot be listed', async () => {
  const fs = memFs()
  const daemon = fakeDaemon(undefined, 'jev-fake-v2', { jev: JEV_STATUS, libraryFails: true })

  const { code } = await captured(() => launchCli('opencode', 6996, [], makeSpawn().fn, undefined, daemon.fetch, undefined, fs))

  assert.equal(code, 1)
  assert.equal(fs.files.size, 0, 'no harness config may be written for a Jev model')
})

test('a Jev model held in a pool slot beside the chat model does not stop a launch on the chat model', async () => {
  const spawn = makeSpawn()
  const beside = { ...JEV_STATUS, slot: 'pool' }
  const daemon = fakeDaemon(undefined, 'qwen3-8b', { jev: beside })

  const { code } = await captured(() => launchCli('claude', 6996, [], spawn.fn, undefined, daemon.fetch, undefined, memFs()))

  assert.equal(code, 0)
  assert.deepEqual(daemon.loads, [])
  assert.equal(spawn.calls, 1)
  assert.equal(spawn.envs[0]['ANTHROPIC_MODEL'], 'qwen3-8b', 'the agent is pinned to the chat model, not the pooled Jev one')
})

test('a daemon that reports no Jev model launches a loaded chat model without asking for the library', async () => {
  const spawn = makeSpawn()
  const daemon = fakeDaemon(undefined, 'qwen3-8b', { jev: null })

  const { code } = await captured(() => launchCli('claude', 6996, [], spawn.fn, undefined, daemon.fetch, undefined, memFs()))

  assert.equal(code, 0)
  assert.equal(spawn.envs[0]['ANTHROPIC_MODEL'], 'qwen3-8b')
  assert.equal(daemon.requests.some((url) => url.includes(LIBRARY_LISTING)), false, 'the status already answers it')
})

test('--model naming the loaded Jev model still never launches when the library cannot be listed', async () => {
  const spawn = makeSpawn()
  const daemon = fakeDaemon(undefined, 'jev-fake-v2', { jev: JEV_STATUS, libraryFails: true })

  const { code } = await captured(() => launchCli('claude', 6996, [], spawn.fn, 'jev-fake-v2', daemon.fetch))

  assert.equal(code, 1)
  assert.deepEqual(daemon.loads, [], 'nothing may be loaded')
  assert.equal(spawn.calls, 0, 'the agent must not be launched')
})
