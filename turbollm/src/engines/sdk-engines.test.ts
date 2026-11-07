// D-3 (ADR-462): the daemon reads the in-app SDK's engine list (GET /sdk/v1/engines) once per start, and an
// unreadable list never fails the boot: every failure is `null`, which the reconciler reads as "change nothing".
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readSdkEngines } from './sdk-engines'
import { fakeSdk, sdkEnginesReply } from '../test-support/fake-sdk'

const BASE_URL = 'http://127.0.0.1:41000'
const ENV = { TURBOLLM_ANDROID_SDK_TOKEN: 'tok-123' }

const LLAMA_ENTRY = {
  id: 'llama.cpp-cpu', name: 'llama.cpp (CPU)', kind: 'llama.cpp', formats: ['gguf'], backends: ['cpu'], available: true,
}
const LITERT_ENTRY = {
  id: 'litert-lm', name: 'LiteRT-LM', kind: 'litert-lm', formats: ['litertlm'], backends: ['gpu', 'cpu'], available: true,
}

function readWith(reply: Parameters<typeof fakeSdk>[0][string]) {
  const sdk = fakeSdk({ 'GET /sdk/v1/engines': reply })
  return { sdk, result: readSdkEngines(BASE_URL, ENV, sdk.fetch) }
}

test('the architecture §2.4 reply parses to both engines, exactly', async () => {
  const { result } = readWith([sdkEnginesReply([LLAMA_ENTRY, LITERT_ENTRY])])
  assert.deepEqual(await result, [LLAMA_ENTRY, LITERT_ENTRY])
})

test('the request carries the SDK bearer from the environment', async () => {
  const { sdk, result } = readWith([sdkEnginesReply([LLAMA_ENTRY])])
  await result
  assert.deepEqual(sdk.routesCalled(), ['GET /sdk/v1/engines'])
  assert.equal(sdk.sent[0].authorization, 'Bearer tok-123')
})

test('a 401 or a 500 reads as null', async () => {
  for (const status of [401, 500]) {
    const listShaped = { object: 'list', data: [LLAMA_ENTRY] }
    assert.equal(await readWith([{ status, body: listShaped }]).result, null, `status ${status}`)
  }
})

test('a body that is not JSON reads as null', async () => {
  const fetchFn = (async () => new Response('not json', { status: 200 })) as typeof fetch
  assert.equal(await readSdkEngines(BASE_URL, ENV, fetchFn), null)
})

test('a body whose data is not an array reads as null', async () => {
  assert.equal(await readWith([{ status: 200, body: { object: 'list', data: {} } }]).result, null)
})

test('a fetch that rejects (a timeout, a refused connection) reads as null and never throws', async () => {
  assert.equal(await readWith(['unreachable']).result, null)
  const timedOut = (async () => {
    throw new DOMException('The operation was aborted due to timeout', 'TimeoutError')
  }) as typeof fetch
  assert.equal(await readSdkEngines(BASE_URL, ENV, timedOut), null)
})

test('the request is bounded by an abort signal', async () => {
  let signal: AbortSignal | null | undefined
  const fetchFn = (async (_input: string | URL | Request, init?: RequestInit) => {
    signal = init?.signal
    return new Response(JSON.stringify({ object: 'list', data: [] }), { status: 200 })
  }) as typeof fetch
  await readSdkEngines(BASE_URL, ENV, fetchFn)
  assert.ok(signal instanceof AbortSignal)
})

test('an unknown format is dropped from an entry, and an entry left with none is dropped', async () => {
  const mixed = { ...LLAMA_ENTRY, formats: ['gguf', 'mlx2'] }
  const onlyUnknown = { ...LITERT_ENTRY, id: 'future', formats: ['mlx2'] }
  assert.deepEqual(await readWith([sdkEnginesReply([mixed, onlyUnknown])]).result, [LLAMA_ENTRY])
})

test('unknown backends are dropped from an entry', async () => {
  const entry = { ...LITERT_ENTRY, backends: ['gpu', 'npu', 'cpu'] }
  assert.deepEqual(await readWith([sdkEnginesReply([entry])]).result, [LITERT_ENTRY])
})

test('an unavailable entry keeps its reason', async () => {
  const unavailable = { ...LLAMA_ENTRY, available: false, reason: 'No llama.cpp library in this build runs on this CPU.' }
  assert.deepEqual(await readWith([sdkEnginesReply([unavailable])]).result, [unavailable])
})

test('an entry missing an id, a name, a kind or a boolean available is dropped', async () => {
  const broken = [
    { ...LLAMA_ENTRY, id: '' },
    { ...LLAMA_ENTRY, name: 3 },
    { ...LLAMA_ENTRY, kind: undefined },
    { ...LLAMA_ENTRY, available: 'yes' },
    'not an entry',
  ]
  assert.deepEqual(await readWith([sdkEnginesReply([...broken, LITERT_ENTRY])]).result, [LITERT_ENTRY])
})
