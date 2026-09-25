// Jev (ADR-434 (c), (d), ADR-439): the systemone client and the copyable curl of the API view.
//
// The curl is the one place the playground hands a user something they will paste into a
// shell, so two things are asserted byte-for-byte: a single quote inside their own text is
// shell-escaped (an un-escaped one ends the -d argument and the paste silently sends a
// different body), and the stored auth key is NEVER in it — the API view is the screenshot
// people put in issues and blog posts.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from './api'
import * as api from './jev-api'
import { MAX_JEV_INPUTS, buildCurl, getActivity, systemone } from './jev-api'
import type { SystemOneRequest, SystemOneResponse } from './systemone-types'
import type { ActiveWork } from './types'

const AUTH_KEY = 'tllm.authToken'

const IDLE: ActiveWork = { items: [], engineGenerating: false }

const SYSTEMONE_REQUEST: SystemOneRequest = {
  state: 'It is fine',
  model: 'm',
  questions: { q: { type: 'noul', instructions: 'i' } },
}

const SYSTEMONE_REPLY: SystemOneResponse = {
  model: 'm',
  answers: { q: { type: 'noul', noul: 0.945 } },
  usage: { input_tokens: 42, output_tokens: 1 },
}

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
  it("mirrors the gateway's batch limit", () => {
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

// Laya (huggingface.co/convaiinnovations/laya) answers the same POST /v1/systemone endpoint as
// Jev, but with a top-level `routing` block (which of its own checkpoints answered, and why) and
// extra per-answer fields (`answer_confidence`, `action`) that Jev responses never carry. The
// validator only checks the shape it actually reads (answers/usage) — it must not reject a real
// reply just because it carries fields beyond that, the same way it doesn't today for whatever
// extra fields a Jev response's own `answers` entries might carry.
const LAYA_REPLY = {
  model: 'k',
  answers: {
    d: {
      type: 'choice',
      choice: 'billing',
      probabilities: { billing: 0.97, other: 0.03 },
      confidence: 0.87,
      answer_confidence: 0.97,
      action: { act_probability: 1 },
    },
  },
  usage: { input_tokens: 264, output_tokens: 0 },
  routing: { model: 'english', reason: 'English Latin text' },
}

describe('systemone', () => {
  it('accepts a Laya-shaped response — routing and per-answer extras are not grounds to reject it', async () => {
    stubFetch(LAYA_REPLY)
    const res = await systemone(SYSTEMONE_REQUEST)
    expect(res).toEqual(LAYA_REPLY)
  })

  it('posts the request to its own endpoint and returns the parsed answers', async () => {
    const mock = stubFetch(SYSTEMONE_REPLY)
    const res = await systemone(SYSTEMONE_REQUEST)
    const { path, init, headers } = requestOf(mock)
    expect(path).toBe('/v1/systemone')
    expect(init.method).toBe('POST')
    expect(headers['Content-Type']).toBe('application/json')
    expect(init.body).toBe(JSON.stringify(SYSTEMONE_REQUEST))
    expect(res).toEqual(SYSTEMONE_REPLY)
  })

  it('sends the stored key, so the playground works over the LAN too', async () => {
    storage.set(AUTH_KEY, 'secret-key')
    const mock = stubFetch(SYSTEMONE_REPLY)
    await systemone(SYSTEMONE_REQUEST)
    expect(requestOf(mock).headers['X-TurboLLM-Auth']).toBe('secret-key')
  })

  it('turns a 422 refusal into an ApiError that keeps the code and the message', async () => {
    const message = 'questions.q.type must be one of noul, choice, score'
    stubFetch({ error: { code: 'invalid_request', message, type: 'invalid_request_error' } }, 422)
    const refused = systemone(SYSTEMONE_REQUEST)
    await expect(refused).rejects.toMatchObject({ name: 'ApiError', code: 'invalid_request', message, status: 422 })
    await expect(refused).rejects.toBeInstanceOf(ApiError)
  })

  describe('when the server answers 200 with something that is not a System One response', () => {
    const NOT_A_SYSTEMONE_RESPONSE = 'The server answered, but not with a System One response.'

    const stubReply = (respond: () => Response) => vi.stubGlobal('fetch', vi.fn(async () => respond()))
    const jsonReply = (body: unknown) => () => new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })

    it('rejects an empty body with a readable ApiError instead of returning undefined', async () => {
      stubReply(() => new Response('', { status: 200 }))
      const refused = systemone(SYSTEMONE_REQUEST)
      await expect(refused).rejects.toBeInstanceOf(ApiError)
      await expect(refused).rejects.toMatchObject({ code: 'bad_response', message: NOT_A_SYSTEMONE_RESPONSE, status: 200 })
    })

    it.each<[string, () => Response]>([
      ['an html page', () => new Response('<html>Sign in</html>', { status: 200, headers: { 'content-type': 'text/html' } })],
      ['a 204 with no body', () => new Response(null, { status: 204 })],
      ['a JSON null', jsonReply(null)],
      ['a reply without answers', jsonReply({ model: 'm', usage: { input_tokens: 1, output_tokens: 0 } })],
      ['a reply without usage', jsonReply({ model: 'm', answers: {} })],
      ['answers that are an array', jsonReply({ ...SYSTEMONE_REPLY, answers: [] })],
      ['answers that are a string', jsonReply({ ...SYSTEMONE_REPLY, answers: 'none' })],
      ['usage that is a string', jsonReply({ ...SYSTEMONE_REPLY, usage: 'many' })],
      ['usage.input_tokens that is a string', jsonReply({ ...SYSTEMONE_REPLY, usage: { input_tokens: '42', output_tokens: 1 } })],
    ])('rejects %s the same way', async (_case, respond) => {
      stubReply(respond)
      const refused = systemone(SYSTEMONE_REQUEST)
      await expect(refused).rejects.toBeInstanceOf(ApiError)
      await expect(refused).rejects.toMatchObject({ code: 'bad_response', message: NOT_A_SYSTEMONE_RESPONSE })
    })
  })
})

describe('buildCurl for systemone', () => {
  const SYSTEMONE_CURL = 'curl http://localhost:6996/v1/systemone \\\n'
    + '  -H "content-type: application/json" \\\n'
    + '  -d \'{"state":"It is fine","model":"m","questions":{"q":{"type":"noul","instructions":"i"}}}\''

  const bodyOf = (curl: string) => curl.slice(curl.indexOf("-d '") + 4, -1).replaceAll("'\\''", "'")

  it('is the same pasteable three-line command, aimed at /v1/systemone', () => {
    expect(buildCurl('http://localhost:6996', 'systemone', SYSTEMONE_REQUEST)).toBe(SYSTEMONE_CURL)
  })

  it('leads with the auth hint from a LAN origin, where the daemon demands a key', () => {
    const lines = buildCurl('http://192.168.1.5:6996', 'systemone', SYSTEMONE_REQUEST).split('\n')
    expect(lines[0]).toBe('# add -H "X-TurboLLM-Auth: <your key>"')
    expect(lines[1]).toBe('curl http://192.168.1.5:6996/v1/systemone \\')
  })

  it('escapes a single quote in the state so the paste sends the same body', () => {
    const curl = buildCurl('http://localhost:6996', 'systemone', { ...SYSTEMONE_REQUEST, state: "it's fine" })
    expect(curl).toContain('"state":"it\'\\\'\'s fine"')
  })

  it('round-trips: un-escaping the -d argument gives back exactly the request that was posted', () => {
    const quoted = { ...SYSTEMONE_REQUEST, state: "it's fine" }
    for (const request of [SYSTEMONE_REQUEST, quoted]) {
      expect(JSON.parse(bodyOf(buildCurl('http://localhost:6996', 'systemone', request)))).toEqual(request)
    }
  })

  it('never carries the stored key, even from a LAN origin', () => {
    storage.set(AUTH_KEY, 'secret-key')
    expect(buildCurl('http://192.168.1.5:6996', 'systemone', SYSTEMONE_REQUEST)).not.toContain('secret-key')
  })
})

describe('the exported client surface', () => {
  it('no longer offers a classify or a rerank call, only systemone', () => {
    expect('classify' in api).toBe(false)
    expect('rerank' in api).toBe(false)
    expect('systemone' in api).toBe(true)
  })
})
