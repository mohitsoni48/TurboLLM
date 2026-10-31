// The in-app SDK engine answers only its own per-process bearer (plan D-3). callChatUpstream is the one outbound chat
// call (main turn, title, memory, compaction), so the bearer is added there, for the local engine only: a Turbo Link
// turn keeps the link's own credential.
import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { callChatUpstream, type ChatUpstream } from './chat-upstream'

const SDK_TOKEN = 'sdk-process-token'
const LOCAL_SDK: ChatUpstream = { modelField: '/m/a.gguf', modelName: 'a', ctxMax: 4096, target: 'http://engine.invalid', engineKind: 'turbollm-sdk' }
const REMOTE_FROM_SDK_BOX: ChatUpstream = {
  ...LOCAL_SDK,
  target: '',
  remote: { linkId: 'lnk1', baseUrl: 'https://rig.invalid', token: 'tllm-hostsecret', modelKey: 'qwen3-8b|Q4|123' },
}

function withSdkToken(t: TestContext): void {
  const realToken = process.env.TURBOLLM_ANDROID_SDK_TOKEN
  process.env.TURBOLLM_ANDROID_SDK_TOKEN = SDK_TOKEN
  t.after(() => {
    if (realToken === undefined) delete process.env.TURBOLLM_ANDROID_SDK_TOKEN
    else process.env.TURBOLLM_ANDROID_SDK_TOKEN = realToken
  })
}

/** A fetch that records the headers it was sent and answers 200. */
function recordingFetch(): { fetchImpl: typeof fetch; sent: Headers[] } {
  const sent: Headers[] = []
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    sent.push(new Headers(init?.headers))
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  return { fetchImpl, sent }
}

test('a local turn to the SDK engine carries its bearer and stays JSON', async (t) => {
  withSdkToken(t)
  const { fetchImpl, sent } = recordingFetch()
  await callChatUpstream(LOCAL_SDK, { model: 'm', messages: [] }, undefined, fetchImpl)
  assert.equal(sent[0].get('authorization'), `Bearer ${SDK_TOKEN}`)
  assert.equal(sent[0].get('content-type'), 'application/json')
})

test('a local turn to llama.cpp sends no authorization, as before', async (t) => {
  withSdkToken(t)
  const { fetchImpl, sent } = recordingFetch()
  await callChatUpstream({ ...LOCAL_SDK, engineKind: 'llama-server' }, { model: 'm', messages: [] }, undefined, fetchImpl)
  assert.equal(sent[0].has('authorization'), false)
})

test('a Turbo Link turn from a box running the SDK never carries the SDK bearer', async (t) => {
  withSdkToken(t)
  const { fetchImpl, sent } = recordingFetch()
  await callChatUpstream(REMOTE_FROM_SDK_BOX, { model: 'm', messages: [] }, undefined, fetchImpl)
  assert.notEqual(sent[0].get('authorization'), `Bearer ${SDK_TOKEN}`)
})
