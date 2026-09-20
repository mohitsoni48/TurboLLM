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

function makeSpawn(): { calls: number; fn: Parameters<typeof launchCli>[3] } {
  const state = { calls: 0 }
  const fn: Parameters<typeof launchCli>[3] = () => {
    state.calls++
    const ee = new EventEmitter() as ReturnType<typeof import('node:child_process').spawn>
    setImmediate(() => ee.emit('exit', 0, null))
    return ee
  }
  return { get calls() { return state.calls }, fn }
}

interface FakeDaemon {
  fetch: typeof fetch
  /** Every model key a load was requested for. */
  loads: string[]
}

/** A daemon with both models in the library and `lastLoaded` as given. Nothing is loaded unless
 *  `loadedKey` names the model that is already running when the launcher connects. */
function fakeDaemon(lastLoadedKey?: string, loadedKey: string | null = null): FakeDaemon {
  const loads: string[] = []
  let runningKey: string | null = loadedKey
  const fetchImpl = async (input: string | URL | globalThis.Request, init?: RequestInit): Promise<Response> => {
    const url = String(input)
    if (url.includes('/api/v1/status')) {
      const body = runningKey
        ? { engine: { state: 'running' }, model: { key: runningKey, name: runningKey } }
        : { engine: { state: 'idle' }, model: null, ...(lastLoadedKey ? { lastLoaded: { modelKey: lastLoadedKey } } : {}) }
      return { ok: true, status: 200, json: async () => body } as Response
    }
    if (url.includes('/api/v1/models')) {
      return { ok: true, status: 200, json: async () => ({ models: [JEV, CHAT] }) } as Response
    }
    if (url.includes('/api/v1/engine/start')) {
      const parsed = JSON.parse(String(init?.body ?? '{}')) as { modelKey?: string }
      if (parsed.modelKey) { loads.push(parsed.modelKey); runningKey = parsed.modelKey }
      return { ok: true, status: 202, json: async () => ({ ok: true }) } as Response
    }
    return { ok: false, status: 404, json: async () => ({}) } as Response
  }
  return { fetch: fetchImpl as unknown as typeof fetch, loads }
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
