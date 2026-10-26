// Every in-app request to a local LiteRT-LM engine carries its thinking in the field LiteRT-LM reads (a top-level
// reasoning_effort), from callChatUpstream, the one outbound call: the main turn (the chat's Off, a budget), the
// auto-title, memory extraction and compaction (the daemon's own off). Other engines and a Turbo Link host's turn are
// left as they were.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { callChatUpstream, type ChatUpstream } from './chat-upstream'

const LOCAL_LITERT: ChatUpstream = { modelField: '/m/Qwen3.litertlm', modelName: 'Qwen3', ctxMax: 4096, target: 'http://engine.invalid', engineKind: 'litert-lm' }
const LOCAL_LLAMA: ChatUpstream = { ...LOCAL_LITERT, engineKind: 'llama-server' }
const REMOTE: ChatUpstream = { ...LOCAL_LITERT, target: '', remote: { linkId: 'l', baseUrl: 'https://rig.invalid', token: 't', modelKey: 'k' } }

async function sent(upstream: ChatUpstream, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const bodies: Array<Record<string, unknown>> = []
  const fetchImpl = (async (_u: string | URL | Request, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)))
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  await callChatUpstream(upstream, body, undefined, fetchImpl)
  return bodies[0]
}

test('the chat\'s Off, and the daemon\'s own off for a title, reach a LiteRT-LM engine as reasoning_effort none', async () => {
  const off = await sent(LOCAL_LITERT, { model: 'm', messages: [], thinking_budget_tokens: 0, chat_template_kwargs: { enable_thinking: false } })
  assert.equal(off.reasoning_effort, 'none')
  assert.equal(off.thinking_budget_tokens, 0, 'kept for the Android server')
})

test('a thinking budget turns thinking on; the automatic default sends nothing', async () => {
  assert.equal((await sent(LOCAL_LITERT, { model: 'm', messages: [], thinking_budget_tokens: 2048 })).reasoning_effort, 'medium')
  assert.equal('reasoning_effort' in (await sent(LOCAL_LITERT, { model: 'm', messages: [] })), false)
})

test('llama.cpp and a Turbo Link host\'s turn get no reasoning_effort added', async () => {
  const body = { model: 'm', messages: [], thinking_budget_tokens: 0, chat_template_kwargs: { enable_thinking: false } }
  assert.equal('reasoning_effort' in (await sent(LOCAL_LLAMA, body)), false)
  assert.equal('reasoning_effort' in (await sent(REMOTE, body)), false)
})
