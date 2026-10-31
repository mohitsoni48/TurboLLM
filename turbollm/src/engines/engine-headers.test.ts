import { test } from 'node:test'
import assert from 'node:assert/strict'
import { engineRequestHeaders } from './engine-headers'

const SDK = 'turbollm-sdk'

function clientHeaders(): Headers {
  return new Headers({ authorization: 'Bearer user-key', 'x-api-key': 'user-key', 'content-type': 'application/json' })
}

test('the SDK engine gets its own bearer in place of the client credentials', () => {
  const headers = engineRequestHeaders(SDK, clientHeaders(), { TURBOLLM_ANDROID_SDK_TOKEN: 'sdk-token' })
  assert.equal(headers.get('authorization'), 'Bearer sdk-token')
  assert.equal(headers.has('x-api-key'), false)
  assert.equal(headers.get('content-type'), 'application/json')
})

test('the same Headers object is returned, changed in place', () => {
  const headers = clientHeaders()
  assert.equal(engineRequestHeaders(SDK, headers, { TURBOLLM_ANDROID_SDK_TOKEN: 'sdk-token' }), headers)
})

test('every other engine kind keeps the client headers unchanged', () => {
  for (const kind of ['llama-server', 'litert-lm', 'vllm']) {
    const headers = engineRequestHeaders(kind, clientHeaders(), { TURBOLLM_ANDROID_SDK_TOKEN: 'sdk-token' })
    assert.deepEqual([...headers.entries()], [...clientHeaders().entries()], kind)
  }
})

test('the token is read on every call, so a new app process token is used at once', () => {
  const env: NodeJS.ProcessEnv = { TURBOLLM_ANDROID_SDK_TOKEN: 'first' }
  assert.equal(engineRequestHeaders(SDK, new Headers(), env).get('authorization'), 'Bearer first')
  env.TURBOLLM_ANDROID_SDK_TOKEN = 'second'
  assert.equal(engineRequestHeaders(SDK, new Headers(), env).get('authorization'), 'Bearer second')
})

test('without an SDK token the client credentials are still removed and no authorization is sent', () => {
  const headers = engineRequestHeaders(SDK, clientHeaders(), {})
  assert.equal(headers.has('authorization'), false)
  assert.equal(headers.has('x-api-key'), false)
})

test('the environment is the default source of the token', (t) => {
  const previous = process.env.TURBOLLM_ANDROID_SDK_TOKEN
  process.env.TURBOLLM_ANDROID_SDK_TOKEN = 'from-process'
  t.after(() => {
    if (previous === undefined) delete process.env.TURBOLLM_ANDROID_SDK_TOKEN
    else process.env.TURBOLLM_ANDROID_SDK_TOKEN = previous
  })
  assert.equal(engineRequestHeaders(SDK, new Headers()).get('authorization'), 'Bearer from-process')
})
