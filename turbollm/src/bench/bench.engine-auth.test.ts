// Every auto-tune request to the engine carries the auth headers engineRequestHeaders decides (plan D-3), so the
// in-app SDK engine, which answers only its own bearer, would not refuse them with a 401.
import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { BenchRunner } from './bench'

const SDK_TOKEN = 'sdk-process-token'
const TARGET = 'http://engine.invalid'

interface BenchRequests {
  prefillProbe: (target: string, messages: unknown[], budgetMs: number, logPath: string, stepPrefix: string) => Promise<unknown>
  chat: (target: string, messages: unknown[], maxTokens: number, timeoutMs: number) => Promise<unknown>
  chatText: (target: string, content: string, maxTokens: number, timeoutMs: number) => Promise<unknown>
}

function benchOn(engineKind: string): BenchRequests {
  const manager = {
    status: () => ({ state: 'running' }),
    currentOpts: () => ({ engine: { kind: engineKind } }),
    logPath: () => null,
    target: () => TARGET,
  }
  return new BenchRunner(manager as never, {} as never, {} as never, {} as never, 'test', {} as never) as unknown as BenchRequests
}

/** Records the authorization header of every engine request, with the SDK token set, until the test ends. */
function recordAuthorization(t: TestContext): Array<string | null> {
  const seen: Array<string | null> = []
  const realFetch = globalThis.fetch
  const realToken = process.env.TURBOLLM_ANDROID_SDK_TOKEN
  process.env.TURBOLLM_ANDROID_SDK_TOKEN = SDK_TOKEN
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    seen.push(new Headers(init?.headers).get('authorization'))
    return new Response('{}', { status: 500 })
  }) as typeof fetch
  t.after(() => {
    globalThis.fetch = realFetch
    if (realToken === undefined) delete process.env.TURBOLLM_ANDROID_SDK_TOKEN
    else process.env.TURBOLLM_ANDROID_SDK_TOKEN = realToken
  })
  return seen
}

const MESSAGES = [{ role: 'user', content: 'x' }]

test('the prefill probe to the SDK engine carries its bearer', async (t) => {
  const seen = recordAuthorization(t)
  await benchOn('turbollm-sdk').prefillProbe(TARGET, MESSAGES, 5000, '', 'probe')
  assert.deepEqual(seen, [`Bearer ${SDK_TOKEN}`])
})

test('the measured chat to the SDK engine carries its bearer', async (t) => {
  const seen = recordAuthorization(t)
  await benchOn('turbollm-sdk').chat(TARGET, MESSAGES, 8, 5000).catch(() => {})
  assert.deepEqual(seen, [`Bearer ${SDK_TOKEN}`])
})

test('the load-card text request to the SDK engine carries its bearer', async (t) => {
  const seen = recordAuthorization(t)
  await benchOn('turbollm-sdk').chatText(TARGET, 'x', 8, 5000).catch(() => {})
  assert.deepEqual(seen, [`Bearer ${SDK_TOKEN}`])
})

test('a llama.cpp bench request still sends no authorization', async (t) => {
  const seen = recordAuthorization(t)
  await benchOn('llama-server').chat(TARGET, MESSAGES, 8, 5000).catch(() => {})
  assert.deepEqual(seen, [null])
})
