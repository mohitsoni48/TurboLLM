// The Manager drives the in-app TurboLLM SDK engine (kind 'turbollm-sdk') that the app, not the daemon, runs (plan D-6,
// architecture §6.3 and §6.6): a load is POST /sdk/v1/load plus status polling inside the usual readiness budget, a
// stop is an unload, and nothing is spawned. The SDK is an injected fake fetch, so no socket is opened (ADR-215).
import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { ConfigStore } from '../config/config'
import type { LoadProfile } from '../models/profile'
import { Manager, type StartOpts } from './manager'
import { fakeSdk, sdkAccepted, sdkStatus, type SdkReply } from '../test-support/fake-sdk'
import { tmpDir } from '../test-support/tmp'

const SDK_URL = 'http://127.0.0.1:6997'
const TOKEN_ENV = 'TURBOLLM_ANDROID_SDK_TOKEN'
const MODEL_PATH = '/data/user/0/dev.turbollm.android/files/models/qwen.gguf'
const DAEMON_DEFAULT_CTX = 8192

const loadsToReady: Record<string, SdkReply[]> = {
  'POST /sdk/v1/load': [sdkAccepted],
  'GET /sdk/v1/status': [sdkStatus('loading'), sdkStatus('loading'), sdkStatus('ready', { model: { contextSize: 4096 } })],
  'POST /sdk/v1/unload': [sdkStatus('idle')],
}

function sdkEngineLoad(over: Partial<StartOpts> = {}): StartOpts {
  return {
    engine: {
      id: 'sdk', name: 'TurboLLM SDK', binPath: '', kind: 'turbollm-sdk', version: 'in-app', baseUrl: SDK_URL,
      capabilities: { kvTypes: [], flags: [] }, addedAt: '',
    },
    model: { key: 'qwen', name: 'Qwen', quant: 'Q4_K_M', ctx: DAEMON_DEFAULT_CTX, vision: false },
    modelPath: MODEL_PATH,
    extraArgs: [],
    ...over,
  }
}

type SdkFetch = typeof globalThis.fetch

/** A Manager on a fresh data dir whose SDK is `routes` (as `answering` replies to it), with the app's token (null: none)
 *  in the environment for the test. */
function attachedManager(t: TestContext, routes: Record<string, SdkReply[]>, token: string | null = 'tok', answering = (sdk: SdkFetch) => sdk) {
  const previous = process.env[TOKEN_ENV]
  if (token === null) delete process.env[TOKEN_ENV]
  else process.env[TOKEN_ENV] = token
  t.after(() => {
    if (previous === undefined) delete process.env[TOKEN_ENV]
    else process.env[TOKEN_ENV] = previous
  })
  const dataDir = tmpDir('tllm-sdk-engine-')
  const sdk = fakeSdk(routes)
  const manager = new Manager(ConfigStore.load(join(dataDir, 'config.json')), { fetch: answering(sdk.fetch) })
  return { manager, sdk, dataDir }
}

test('a load posts /sdk/v1/load, polls the status until ready, and then the engine is running at the SDK\'s URL', async (t) => {
  const { manager, sdk } = attachedManager(t, loadsToReady)

  await manager.load(sdkEngineLoad())

  assert.equal(manager.status().state, 'running')
  assert.equal(manager.target(), SDK_URL)
  assert.deepEqual(sdk.routesCalled(), ['POST /sdk/v1/load', 'GET /sdk/v1/status', 'GET /sdk/v1/status', 'GET /sdk/v1/status'])
  assert.ok(sdk.sent.every((r) => r.authorization === 'Bearer tok'))
})

test('the load spawns nothing and tracks no pid (the app runs the engine)', async (t) => {
  const { manager, dataDir } = attachedManager(t, loadsToReady)
  let spawned = 0
  const realSpawn = childProcess.spawn
  const spy = t.mock.method(childProcess, 'spawn', ((...args: Parameters<typeof childProcess.spawn>) => {
    spawned++
    return realSpawn(...args)
  }) as typeof childProcess.spawn)
  syncBuiltinESMExports()
  try {
    await manager.load(sdkEngineLoad())
  } finally {
    spy.mock.restore()
    syncBuiltinESMExports()
  }
  assert.equal(manager.status().state, 'running')
  assert.equal(spawned, 0)
  assert.equal(manager.status().pid, 0)
  const pidDir = join(dataDir, 'run')
  assert.ok(!existsSync(pidDir) || readdirSync(pidDir).length === 0, 'no engine pidfile')
  assert.equal(manager.launchCommand(), null, 'there is no command line to copy')
})

test('the load body maps the profile: path, ctx, threads and the LiteRT-LM backend (§6.6)', async (t) => {
  const { manager, sdk } = attachedManager(t, loadsToReady)
  const profile = { ctx: 16384, threads: 6 } as LoadProfile

  await manager.load(sdkEngineLoad({ profile, litertLmConfig: { default: { backend: 'gpu' } } }))

  assert.deepEqual(sdk.sent[0].body, { path: MODEL_PATH, contextSize: 16384, threads: 6, backend: 'gpu' })
})

test('a profile that sets no ctx or threads leaves them to the SDK, and the backend is auto', async (t) => {
  const { manager, sdk } = attachedManager(t, loadsToReady)

  await manager.load(sdkEngineLoad({ profile: { ctx: 0, threads: 0 } as LoadProfile }))

  assert.deepEqual(sdk.sent[0].body, { path: MODEL_PATH, backend: 'auto' })
})

test('E-51: the running model\'s context is the one the SDK really loaded, not the daemon\'s default', async (t) => {
  const { manager } = attachedManager(t, loadsToReady)

  await manager.load(sdkEngineLoad())

  assert.equal(manager.status().model?.ctx, 4096)
  assert.equal(manager.currentOpts()?.model.ctx, 4096)
})

test('G-1: a running SDK engine serves one generation at a time, so the daemon\'s gate queues', async (t) => {
  const { manager } = attachedManager(t, loadsToReady)
  assert.equal(manager.parallelSlots(), null, 'nothing loaded')

  await manager.load(sdkEngineLoad())
  assert.equal(manager.parallelSlots(), 1)

  await manager.stopAndWait()
  assert.equal(manager.parallelSlots(), null, 'stopped')
})

test('a stop posts /sdk/v1/unload with the bearer, and the engine is stopped', async (t) => {
  const { manager, sdk } = attachedManager(t, loadsToReady)
  await manager.load(sdkEngineLoad())

  await manager.stopAndWait()

  assert.equal(manager.status().state, 'stopped')
  assert.equal(manager.target(), null)
  const unload = sdk.sent.at(-1)
  assert.equal(`${unload?.method} ${unload?.path} ${unload?.authorization}`, 'POST /sdk/v1/unload Bearer tok')
})

test('a load the SDK fails is model_load_failed with the SDK\'s message', async (t) => {
  const { manager } = attachedManager(t, {
    'POST /sdk/v1/load': [sdkAccepted],
    'GET /sdk/v1/status': [sdkStatus('error', { error: { message: 'unsupported model architecture', code: 'model_load_failed' } })],
    'POST /sdk/v1/unload': [sdkStatus('idle')],
  })

  await manager.load(sdkEngineLoad())

  const { state, err } = manager.status()
  assert.equal(state, 'error')
  assert.equal(err?.code, 'model_load_failed')
  assert.equal(err?.message, 'unsupported model architecture')
})

test('a failed load asks the SDK to unload what it holds, and the engine keeps the load\'s error', async (t) => {
  const { manager, sdk } = attachedManager(t, {
    'POST /sdk/v1/load': [sdkAccepted],
    'GET /sdk/v1/status': [sdkStatus('error', { error: { message: 'bad magic', code: 'model_load_failed' } })],
    'POST /sdk/v1/unload': [sdkStatus('idle')],
  })

  await manager.load(sdkEngineLoad())
  await manager.stopAndWait()

  assert.equal(sdk.routesCalled().at(-1), 'POST /sdk/v1/unload')
  assert.equal(sdk.routesCalled().filter((r) => r === 'POST /sdk/v1/unload').length, 1)
})

test('a load refused with 409 load_in_progress is surfaced as the engine\'s error', async (t) => {
  const { manager } = attachedManager(t, {
    'POST /sdk/v1/load': [{ status: 409, body: { error: { message: 'A model is already loading.', code: 'load_in_progress' } } }],
    'POST /sdk/v1/unload': [sdkStatus('idle')],
  })

  await manager.load(sdkEngineLoad())

  assert.equal(manager.status().state, 'error')
  assert.equal(manager.status().err?.code, 'model_load_failed')
  assert.equal(manager.status().err?.message, 'A model is already loading.')
})

test('a 401 from the SDK is engine_auth_failed', async (t) => {
  const { manager } = attachedManager(t, {
    'POST /sdk/v1/load': [{ status: 401 }],
    'POST /sdk/v1/unload': [{ status: 401 }],
  }, 'stale')

  await manager.load(sdkEngineLoad())

  assert.equal(manager.status().state, 'error')
  assert.equal(manager.status().err?.code, 'engine_auth_failed')
  assert.equal(manager.status().err?.message, "The app's SDK engine refused the daemon's token (the app was probably restarted).")
})

test('with no SDK token in the environment the load fails fast with engine_unavailable, sending nothing', async (t) => {
  const { manager, sdk } = attachedManager(t, loadsToReady, null)

  await manager.load(sdkEngineLoad())

  assert.equal(manager.status().state, 'error')
  assert.equal(manager.status().err?.code, 'engine_unavailable')
  assert.equal(manager.status().err?.message, 'The TurboLLM SDK engine is not running in this app session.')
  assert.equal(sdk.sent.length, 0)
})

test('the bearer is read from the environment at call time, not when the engine was registered', async (t) => {
  const { manager, sdk } = attachedManager(t, loadsToReady, 'first-launch')
  process.env[TOKEN_ENV] = 'this-launch'

  await manager.load(sdkEngineLoad())

  assert.equal(sdk.sent[0].authorization, 'Bearer this-launch')
})

test('a model still loading when the existing readiness budget runs out is readiness_timeout', async (t) => {
  const { manager } = attachedManager(t, {
    'POST /sdk/v1/load': [sdkAccepted],
    'GET /sdk/v1/status': [sdkStatus('loading')],
    'POST /sdk/v1/unload': [sdkStatus('idle')],
  })
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  let settled = false
  const loading = manager.load(sdkEngineLoad()).finally(() => { settled = true })

  for (let ticks = 0; !settled && ticks < 2000; ticks++) {
    t.mock.timers.tick(500)
    await new Promise((resolve) => setImmediate(resolve))
  }
  await loading

  assert.equal(manager.status().state, 'error')
  assert.equal(manager.status().err?.code, 'readiness_timeout')
  assert.equal(manager.status().err?.message, 'The model did not become ready within 600 seconds.')
})

test('the engine log is one line saying the engine is managed in-app', async (t) => {
  const { manager } = attachedManager(t, loadsToReady)

  await manager.load(sdkEngineLoad())

  const log = readFileSync(manager.logPath(), 'utf8')
  assert.deepEqual(log.trimEnd().split('\n'), ['Engine is managed in-app by the TurboLLM SDK; there is no engine log.'])
})

test('launch flags the SDK cannot apply (ngl, llama-server args) are named as ignored', async (t) => {
  const { manager, sdk } = attachedManager(t, loadsToReady)

  await manager.load(sdkEngineLoad({ extraArgs: ['-ngl', '99', '--flash-attn', 'on'] }))

  const log = readFileSync(manager.logPath(), 'utf8')
  assert.match(log, /ignores these launch settings: -ngl 99 --flash-attn on/)
  assert.ok(!JSON.stringify(sdk.sent[0].body).includes('ngl'), 'they are not sent')
})

// Review C-3: the SDK's unload waits for a native load in progress, so a Stop during a slow load can take longer than
// the spawned engine's 10 s + kill + 5 s. Killing an attached engine is the same unload, so the next load must wait for
// that unload (within the load budget) instead of finding the Manager still 'stopping' and failing with BusyError.
const SLOW_UNLOAD_MS = 20_000

/** An SDK whose model stays 'loading' until a second load is posted, and whose unload answers after SLOW_UNLOAD_MS. */
function slowUnloadSdk(t: TestContext) {
  let loadsPosted = 0
  const slowly = (recorded: SdkFetch) => (async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input)).pathname
    if (path === '/sdk/v1/load') loadsPosted++
    if (path === '/sdk/v1/unload') await new Promise((resolve) => setTimeout(resolve, SLOW_UNLOAD_MS))
    if (path !== '/sdk/v1/status') return recorded(input, init)
    await recorded(input, init)
    return new Response(JSON.stringify(loadsPosted >= 2 ? { state: 'ready', model: {} } : { state: 'loading' }))
  }) as SdkFetch
  const routes = { 'POST /sdk/v1/load': [sdkAccepted], 'POST /sdk/v1/unload': [sdkStatus('idle')] }
  const { manager } = attachedManager(t, routes, 'tok', slowly)
  return { manager, loadsPosted: () => loadsPosted }
}

test('C-3: a Stop during a slow load, then a new load, waits for the SDK\'s unload and loads the new model', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  const { manager, loadsPosted } = slowUnloadSdk(t)
  const settle = async (done: () => boolean) => {
    for (let ticks = 0; !done() && ticks < 200; ticks++) {
      t.mock.timers.tick(500)
      await new Promise((resolve) => setImmediate(resolve))
    }
  }
  let firstSettled = false
  const first = manager.load(sdkEngineLoad()).finally(() => { firstSettled = true })
  await settle(() => loadsPosted() === 1)

  manager.stop()
  await settle(() => firstSettled)
  await first
  let secondSettled = false
  const second = manager.load(sdkEngineLoad({ model: { key: 'qwen-b', name: 'Qwen B', quant: 'Q4_K_M', ctx: DAEMON_DEFAULT_CTX, vision: false } }))
    .catch(() => {})
    .finally(() => { secondSettled = true })
  await settle(() => secondSettled)
  await second

  assert.equal(loadsPosted(), 2, 'the second model\'s load was sent')
  assert.notEqual(manager.status().err?.code, 'load_failed')
  assert.equal(manager.status().state, 'running')
  assert.equal(manager.status().model?.key, 'qwen-b')
})
