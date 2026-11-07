// How the Manager reaches the in-app TurboLLM SDK engine (plan D-6, architecture §4.3 and §6.3): it spawns nothing, it
// asks the app's SDK over loopback HTTP with the per-process bearer. Loading is asynchronous (202, then the status is
// polled), and stopping is an unload. Every request here goes to an injected fake fetch: no socket is opened.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ChildProcess } from 'node:child_process'
import { AttachedTransport, SdkEngineError, SpawnedTransport } from './transport'
import { fakeSdk, sdkAccepted, sdkStatus } from '../test-support/fake-sdk'
import type { Engine } from '../config/config'
import { sdkLoadRequest, type StartOpts } from './manager'

const SDK_URL = 'http://sdk.invalid:1'
const LOAD = { path: '/data/models/qwen.gguf', backend: 'auto' as const }

async function refusal(promise: Promise<unknown>): Promise<SdkEngineError> {
  try {
    await promise
  } catch (e) {
    assert.ok(e instanceof SdkEngineError, `expected an SdkEngineError, got ${String(e)}`)
    return e
  }
  assert.fail('expected the call to be refused')
}

test('the engine is reached at the base URL the app handed over', () => {
  assert.equal(new AttachedTransport(SDK_URL, () => 'tok').target(), SDK_URL)
})

test('every request carries the SDK bearer, read from the provider on each call', () => {
  let token = 'first'
  const transport = new AttachedTransport(SDK_URL, () => token)
  assert.deepEqual(transport.headers(), { Authorization: 'Bearer first' })
  token = 'second'
  assert.deepEqual(transport.headers(), { Authorization: 'Bearer second' })
})

test('start() posts the load, polls the status until ready, and returns the model the SDK loaded', async () => {
  const sdk = fakeSdk({
    'POST /sdk/v1/load': [sdkAccepted],
    'GET /sdk/v1/status': [sdkStatus('loading'), sdkStatus('loading'), sdkStatus('ready', { model: { contextSize: 4096 } })],
  })
  const transport = new AttachedTransport(SDK_URL, () => 'tok', sdk.fetch)

  const model = await transport.start({ ...LOAD, contextSize: 8192, threads: 4 }, 60_000)

  assert.equal(model.contextSize, 4096)
  assert.deepEqual(sdk.routesCalled(), [
    'POST /sdk/v1/load', 'GET /sdk/v1/status', 'GET /sdk/v1/status', 'GET /sdk/v1/status',
  ])
  assert.deepEqual(sdk.sent[0].body, { ...LOAD, contextSize: 8192, threads: 4 })
  assert.ok(sdk.sent.every((r) => r.authorization === 'Bearer tok'), 'the load and every poll carry the bearer')
})

test('the token is read at call time: a poll after the token changed carries the new one', async () => {
  let token = 'before'
  const sdk = fakeSdk({
    'POST /sdk/v1/load': [sdkAccepted],
    'GET /sdk/v1/status': [sdkStatus('ready', { model: {} })],
  })
  const transport = new AttachedTransport(SDK_URL, () => token, sdk.fetch)
  const started = transport.start(LOAD, 60_000)
  token = 'after'
  await started
  assert.equal(sdk.sent[0].authorization, 'Bearer before')
  assert.equal(sdk.sent[1].authorization, 'Bearer after')
})

test('a load the SDK reports as failed is refused as model_load_failed with the SDK\'s own message', async () => {
  const sdk = fakeSdk({
    'POST /sdk/v1/load': [sdkAccepted],
    'GET /sdk/v1/status': [sdkStatus('error', { error: { message: 'not enough memory', code: 'insufficient_memory' } })],
  })
  const e = await refusal(new AttachedTransport(SDK_URL, () => 'tok', sdk.fetch).start(LOAD, 60_000))
  assert.equal(e.code, 'model_load_failed')
  assert.equal(e.message, 'not enough memory')
})

test('a load refused while another is in progress (409) is surfaced with the SDK\'s message, not retried', async () => {
  const sdk = fakeSdk({
    'POST /sdk/v1/load': [{ status: 409, body: { error: { message: 'A model is already loading.', code: 'load_in_progress' } } }],
  })
  const e = await refusal(new AttachedTransport(SDK_URL, () => 'tok', sdk.fetch).start(LOAD, 60_000))
  assert.equal(e.code, 'model_load_failed')
  assert.equal(e.message, 'A model is already loading.')
  assert.equal(sdk.sent.length, 1, 'one load request and no retry')
})

test('a 401 means the app no longer knows the daemon\'s token: engine_auth_failed', async () => {
  const sdk = fakeSdk({ 'POST /sdk/v1/load': [{ status: 401, body: { error: { message: 'bad key', code: 'invalid_api_key' } } }] })
  const e = await refusal(new AttachedTransport(SDK_URL, () => 'stale', sdk.fetch).start(LOAD, 60_000))
  assert.equal(e.code, 'engine_auth_failed')
  assert.equal(e.message, "The app's SDK engine refused the daemon's token (the app was probably restarted).")
})

test('a 401 on a status poll is engine_auth_failed too', async () => {
  const sdk = fakeSdk({ 'POST /sdk/v1/load': [sdkAccepted], 'GET /sdk/v1/status': [{ status: 401 }] })
  const e = await refusal(new AttachedTransport(SDK_URL, () => 'tok', sdk.fetch).start(LOAD, 60_000))
  assert.equal(e.code, 'engine_auth_failed')
})

test('an SDK that cannot be reached is engine_unavailable', async () => {
  const sdk = fakeSdk({ 'POST /sdk/v1/load': ['unreachable'] })
  const e = await refusal(new AttachedTransport(SDK_URL, () => 'tok', sdk.fetch).start(LOAD, 60_000))
  assert.equal(e.code, 'engine_unavailable')
  assert.equal(e.message, 'The TurboLLM SDK engine is not running in this app session.')
})

test('a model still loading when the readiness budget runs out is readiness_timeout', async () => {
  const sdk = fakeSdk({ 'POST /sdk/v1/load': [sdkAccepted], 'GET /sdk/v1/status': [sdkStatus('loading')] })
  const e = await refusal(new AttachedTransport(SDK_URL, () => 'tok', sdk.fetch).start(LOAD, 100))
  assert.equal(e.code, 'readiness_timeout')
  assert.equal(e.message, 'The model did not become ready within 0 seconds.')
})

test('stop() posts the unload with the bearer, and ended resolves with it', async () => {
  const sdk = fakeSdk({ 'POST /sdk/v1/unload': [sdkStatus('idle')] })
  const transport = new AttachedTransport(SDK_URL, () => 'tok', sdk.fetch)
  let ended = false
  void transport.ended.then(() => { ended = true })

  await transport.stop()
  await Promise.resolve()

  assert.deepEqual(sdk.sent.map((r) => `${r.method} ${r.path} ${r.authorization}`), ['POST /sdk/v1/unload Bearer tok'])
  assert.ok(ended, 'ended resolves with the unload')
})

test('kill() asks for the same unload, once, however often it is called', async () => {
  const sdk = fakeSdk({ 'POST /sdk/v1/unload': [sdkStatus('idle')] })
  const transport = new AttachedTransport(SDK_URL, () => 'tok', sdk.fetch)
  transport.kill()
  transport.kill()
  await transport.stop()
  assert.equal(sdk.sent.length, 1)
})

test('an unload that cannot reach the SDK still ends the engine for the daemon', async () => {
  const sdk = fakeSdk({ 'POST /sdk/v1/unload': ['unreachable'] })
  const transport = new AttachedTransport(SDK_URL, () => 'tok', sdk.fetch)
  await transport.stop()
  await transport.ended
})

test('a stop while the model is loading abandons the status polling', async () => {
  const sdk = fakeSdk({
    'POST /sdk/v1/load': [sdkAccepted],
    'GET /sdk/v1/status': [sdkStatus('loading')],
    'POST /sdk/v1/unload': [sdkStatus('idle')],
  })
  const transport = new AttachedTransport(SDK_URL, () => 'tok', sdk.fetch)
  const started = transport.start(LOAD, 60_000)
  await transport.stop()
  const e = await refusal(started)
  assert.equal(e.code, 'load_abandoned')
  assert.ok(!sdk.routesCalled().includes('GET /sdk/v1/status'), 'no poll after the stop')
})

// Review C-3: how long a stop may take is the transport's to say. A spawned engine is forced after a grace; the SDK's
// unload cannot be forced (its kill is the same unload), so the Manager waits for it within the load budget instead.
test('a spawned engine is forced to stop after a grace; the SDK engine is not', () => {
  const neverStarted = {} as ChildProcess
  assert.equal(new SpawnedTransport(neverStarted, 1, Promise.resolve()).forcesStop(), true)
  assert.equal(new AttachedTransport(SDK_URL, () => 'tok').forcesStop(), false)
})

// ADR-462 (plan D-9): a load on an SDK row names that row's SDK engine, so the SDK refuses a model the engine cannot
// read instead of routing it to whichever engine reads its format. The M1 legacy row names none: the SDK routes it by
// format, as before.

function sdkRowOpts(sdkEngine?: Engine['sdkEngine']): StartOpts {
  const engine: Engine = {
    id: 'row', name: 'LiteRT-LM', binPath: '', kind: 'turbollm-sdk', version: 'in-app', baseUrl: SDK_URL,
    capabilities: { kvTypes: [], flags: [] }, addedAt: '', ...(sdkEngine ? { sdkEngine } : {}),
  }
  return { engine, model: { key: 'k', name: 'qwen', quant: 'Q4_K_M', ctx: 4096, vision: false }, modelPath: LOAD.path, extraArgs: [] }
}

test('a load on the LiteRT-LM SDK row names its engine in the body', () => {
  const opts = sdkRowOpts({ id: 'litert-lm', kind: 'litert-lm', formats: ['litertlm'], backends: ['gpu', 'cpu'] })
  assert.equal(sdkLoadRequest(opts).engine, 'litert-lm')
})

test('a load on the legacy SDK row sends no engine key at all', () => {
  assert.equal('engine' in sdkLoadRequest(sdkRowOpts()), false)
})

test('the SDK\'s engine_format_mismatch refusal is model_load_failed carrying the SDK\'s own message', async () => {
  const message = "LiteRT-LM (litert-lm) can't read GGUF models."
  const sdk = fakeSdk({
    'POST /sdk/v1/load': [{ status: 400, body: { error: { message, type: 'invalid_request_error', code: 'engine_format_mismatch', param: 'engine' } } }],
  })
  const transport = new AttachedTransport(SDK_URL, () => 'tok', sdk.fetch)
  const err = await refusal(transport.start({ ...LOAD, engine: 'litert-lm' }, 60_000))
  assert.equal(err.code, 'model_load_failed')
  assert.equal(err.message, message)
  assert.deepEqual(sdk.sent[0].body, { ...LOAD, engine: 'litert-lm' })
  assert.deepEqual(sdk.routesCalled(), ['POST /sdk/v1/load'], 'no retry')
})
