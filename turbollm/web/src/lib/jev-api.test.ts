// Jev (ADR-434 (c), (d)): the classify/rerank client and the copyable curl of the API view.
//
// The curl is the one place the playground hands a user something they will paste into a
// shell, so two things are asserted byte-for-byte: a single quote inside their own text is
// shell-escaped (an un-escaped one ends the -d argument and the paste silently sends a
// different body), and the stored auth key is NEVER in it — the API view is the screenshot
// people put in issues and blog posts.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from './api'
import { MAX_JEV_INPUTS, buildCurl, classify, getActivity, rerank } from './jev-api'
import type { ActiveWork, ClassifyResponse, RerankResponse } from './types'

const AUTH_KEY = 'tllm.authToken'

const KITCHEN: ClassifyResponse = {
  model: 'qwen3.5 4b nli v2|mlx-fp16|9012345678',
  results: [
    { hypothesis: 'Someone is preparing food.', label: 'entailment', probs: { contradiction: 0, entailment: 0.957, neutral: 0.043 } },
  ],
  usage: { prompt_tokens: 69, total_tokens: 69 },
}

const FRANCE: RerankResponse = {
  model: 'qwen3.5 4b nli v2|mlx-fp16|9012345678',
  results: [{ index: 1, document: { text: 'Paris' }, relevance_score: 0.941, label: 'entailment' }],
  usage: { prompt_tokens: 51, total_tokens: 51 },
}

const IDLE: ActiveWork = { items: [], engineGenerating: false }

let storage: Map<string, string>

beforeEach(() => {
  vi.restoreAllMocks()
  storage = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => { storage.set(k, v) },
    removeItem: (k: string) => { storage.delete(k) },
    clear: () => storage.clear(),
  })
})

function stubFetch(body: unknown, status = 200) {
  const mock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(
    JSON.stringify(body),
    { status, headers: { 'content-type': 'application/json' } },
  ))
  vi.stubGlobal('fetch', mock)
  return mock
}

function requestOf(mock: ReturnType<typeof stubFetch>) {
  const [path, init] = mock.mock.calls[0]
  return { path: String(path), init: init as RequestInit, headers: (init as RequestInit).headers as Record<string, string> }
}

describe('classify', () => {
  it('posts the request body to the gateway endpoint', async () => {
    const mock = stubFetch(KITCHEN)
    const res = await classify({ model: 'm', premise: 'p', hypotheses: ['h'] })
    const { path, init, headers } = requestOf(mock)
    expect(path).toBe('/v1/classify')
    expect(init.method).toBe('POST')
    expect(headers['Content-Type']).toBe('application/json')
    expect(init.body).toBe('{"model":"m","premise":"p","hypotheses":["h"]}')
    expect(res).toEqual(KITCHEN)
  })

  it('sends the stored key, so the playground works over the LAN too', async () => {
    storage.set(AUTH_KEY, 'secret-key')
    const mock = stubFetch(KITCHEN)
    await classify({ model: 'm', premise: 'p', hypotheses: ['h'] })
    expect(requestOf(mock).headers['X-TurboLLM-Auth']).toBe('secret-key')
  })

  it('turns the gateway refusal into an ApiError that keeps the machine-checkable code', async () => {
    stubFetch({ error: { code: 'not_a_jev_model', message: 'x', type: 'invalid_request_error' } }, 400)
    await expect(classify({ model: 'm', premise: 'p', hypotheses: ['h'] })).rejects.toMatchObject({
      name: 'ApiError',
      code: 'not_a_jev_model',
      message: 'x',
      status: 400,
    })
    await expect(classify({ model: 'm', premise: 'p', hypotheses: ['h'] })).rejects.toBeInstanceOf(ApiError)
  })
})

describe('rerank', () => {
  it('posts the request body to its own endpoint', async () => {
    const mock = stubFetch(FRANCE)
    const res = await rerank({ model: 'm', query: 'q', documents: ['a', 'b'] })
    const { path, init } = requestOf(mock)
    expect(path).toBe('/v1/rerank')
    expect(init.method).toBe('POST')
    expect(init.body).toBe('{"model":"m","query":"q","documents":["a","b"]}')
    expect(res).toEqual(FRANCE)
  })
})

describe('getActivity', () => {
  it('reads the daemon probe for what a load would interrupt', async () => {
    const mock = stubFetch(IDLE)
    const res = await getActivity()
    const { path, init } = requestOf(mock)
    expect(path).toBe('/api/v1/activity')
    expect(init.method).toBeUndefined()
    expect(res).toEqual(IDLE)
  })
})

describe('MAX_JEV_INPUTS', () => {
  it('mirrors the gateway limit, so the panels can refuse before the round trip', () => {
    expect(MAX_JEV_INPUTS).toBe(128)
  })
})

describe('buildCurl', () => {
  const body = { model: 'm', premise: 'p', hypotheses: ['h'] }

  it('is a pasteable three-line command from a loopback origin', () => {
    expect(buildCurl('http://localhost:6996', 'classify', body)).toBe(
      'curl http://localhost:6996/v1/classify \\\n'
      + '  -H "content-type: application/json" \\\n'
      + '  -d \'{"model":"m","premise":"p","hypotheses":["h"]}\'',
    )
  })

  it('names the rerank endpoint for a choose run', () => {
    expect(buildCurl('http://localhost:6996', 'rerank', { model: 'm', query: 'q', documents: ['a'] })).toBe(
      'curl http://localhost:6996/v1/rerank \\\n'
      + '  -H "content-type: application/json" \\\n'
      + '  -d \'{"model":"m","query":"q","documents":["a"]}\'',
    )
  })

  it('adds no auth hint for 127.0.0.1 or [::1] — those need no key', () => {
    expect(buildCurl('http://127.0.0.1:6996', 'classify', body)).not.toContain('X-TurboLLM-Auth')
    expect(buildCurl('http://[::1]:6996', 'classify', body)).not.toContain('X-TurboLLM-Auth')
  })

  it('leads with the auth hint from a LAN origin, where the daemon demands a key', () => {
    const lines = buildCurl('http://192.168.1.5:6996', 'classify', body).split('\n')
    expect(lines[0]).toBe('# add -H "X-TurboLLM-Auth: <your key>"')
    expect(lines[1]).toBe('curl http://192.168.1.5:6996/v1/classify \\')
  })

  it('escapes a single quote in the user\'s own text so the paste sends the same body', () => {
    const curl = buildCurl('http://localhost:6996', 'classify', { model: 'm', premise: "it's fine", hypotheses: [] })
    expect(curl).toContain('-d \'{"model":"m","premise":"it\'\\\'\'s fine","hypotheses":[]}\'')
  })

  it('never carries the stored key, however loud the origin is', () => {
    storage.set(AUTH_KEY, 'secret-key')
    expect(buildCurl('http://192.168.1.5:6996', 'classify', body)).not.toContain('secret-key')
  })
})
