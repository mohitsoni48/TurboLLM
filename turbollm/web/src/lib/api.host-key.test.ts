// The daemon refuses a host-only setting (PATCH /api/v1/settings) and "Always Allow" on a tool
// call with 403 api_key_required when this browser presented no valid key. With requireApiKey off
// nothing 401s, so this code is the only thing that can raise the key prompt for, say, the owner
// of a Docker install at http://localhost:6996, who arrives from the bridge address. Before, both
// clients only threw, and the Settings screen and the approval bar showed a toast with nowhere to
// enter the key. Mirrors code-api.test.ts's localStorage/fetch stubbing.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError, KEY_CHECK_TIMEOUT_MS, hostKeyAccepted, hostKeyCheck, saveSettings, setAuthToken, statusKeyCheck } from './api'
import { respondToolApproval } from './chat-api'
import { clearHostKeyNeeded, isHostKeyNeeded } from './auth-signal'

function refusal(code: string, message: string) {
  return vi.fn(async () => new Response(JSON.stringify({ error: { code, message } }), {
    status: 403,
    headers: { 'content-type': 'application/json' },
  }))
}

beforeEach(() => {
  vi.restoreAllMocks()
  const store = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v) },
    removeItem: (k: string) => { store.delete(k) },
    clear: () => store.clear(),
  })
  clearHostKeyNeeded()
})

describe('api_key_required asks this browser for a key', () => {
  it('saveSettings: a host-only setting refused for want of a key raises the key prompt and still throws', async () => {
    vi.stubGlobal('fetch', refusal('api_key_required', 'Changing the Hugging Face token requires a valid API key.'))
    const err = await saveSettings({ hfToken: 'hf_mine' }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect((err as ApiError).code).toBe('api_key_required')
    expect((err as ApiError).message).toBe('Changing the Hugging Face token requires a valid API key.')
    expect(isHostKeyNeeded()).toBe(true)
  })

  it('respondToolApproval: "Always Allow" refused for want of a key raises the key prompt', async () => {
    vi.stubGlobal('fetch', refusal('api_key_required', 'Allowing a tool for every future chat requires a valid API key — use "Allow for this chat" instead.'))
    await expect(respondToolApproval('c1', 't1', 'run_code', 'always_allow')).rejects.toBeInstanceOf(ApiError)
    expect(isHostKeyNeeded()).toBe(true)
  })

  it('any other 403 does not: no key would help a remote token refused "Always Allow"', async () => {
    vi.stubGlobal('fetch', refusal('forbidden', 'A remote access token cannot change tool permissions for every future chat — use "Allow for this chat" instead.'))
    await expect(respondToolApproval('c1', 't1', 'run_code', 'always_allow')).rejects.toBeInstanceOf(ApiError)
    await expect(saveSettings({ theme: 'dark' })).rejects.toBeInstanceOf(ApiError)
    expect(isHostKeyNeeded()).toBe(false)
  })
})

// The key this browser has, checked through the host gate: by EnginesScreen before a git build's
// Remove, and by App.tsx before closing that prompt once a key judged by /status is stored.
describe('hostKeyAccepted', () => {
  it('is false when the host gate refuses the key (403, or 401 with requireApiKey on), true when it takes it', async () => {
    vi.stubGlobal('fetch', refusal('forbidden', 'API keys are only visible from this machine until "Require an API key" is turned on.'))
    expect(await hostKeyAccepted()).toBe(false)
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: { code: 'unauthorized', message: 'A valid API key is required for non-local access.' } }), { status: 401 })))
    expect(await hostKeyAccepted()).toBe(false)
    const ok = vi.fn(async () => new Response(JSON.stringify({ keys: [] }), { status: 200 }))
    vi.stubGlobal('fetch', ok)
    expect(await hostKeyAccepted()).toBe(true)
    expect(ok).toHaveBeenCalledWith('/api/v1/keys', expect.anything())
  })

  it('a dropped connection says nothing about the key: accepted, as before the check', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch') }))
    expect(await hostKeyAccepted()).toBe(true)
  })
})

// The prompt checks a pasted key with these before it replaces the stored one, which can be a
// remote-access token that cannot be recovered. Only an answer about the key decides: no answer
// (a tunnel's 502 while the daemon restarts, a dropped connection) is 'unchecked', not taken.
describe('hostKeyCheck', () => {
  it('sends the key it is given in place of the stored one without storing it or raising a key prompt: a 403 or 401 refuses it, a 2xx takes it', async () => {
    setAuthToken('tllm-remote')
    const refused = refusal('api_key_required', 'This change requires a valid API key.')
    vi.stubGlobal('fetch', refused)
    expect(await hostKeyCheck('tllm-typo')).toBe('refused')
    expect(refused).toHaveBeenCalledWith('/api/v1/keys', expect.objectContaining({ headers: expect.objectContaining({ 'X-TurboLLM-Auth': 'tllm-typo' }) }))
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: { code: 'unauthorized', message: 'A valid API key is required for non-local access.' } }), { status: 401 })))
    expect(await hostKeyCheck('tllm-typo')).toBe('refused')
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ keys: [] }), { status: 200 })))
    expect(await hostKeyCheck('tllm-right')).toBe('accepted')
    expect(localStorage.getItem('tllm.authToken')).toBe('tllm-remote')
    expect(isHostKeyNeeded()).toBe(false)
  })

  it('is "unchecked", not accepted, on a 5xx or a dropped connection, which say nothing about the key', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('Bad Gateway', { status: 502 })))
    expect(await hostKeyCheck('tllm-typo')).toBe('unchecked')
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch') }))
    expect(await hostKeyCheck('tllm-typo')).toBe('unchecked')
  })
})

// A check with no answer at all (a tunnel holding the connection open) left the prompt's Connect
// disabled, with no hint, for as long as it was out.
describe('a key check that gets no answer at all', () => {
  it('gives up after 10 s: "unchecked" for hostKeyCheck and statusKeyCheck, and hostKeyAccepted counts it as a dropped connection', async () => {
    vi.useFakeTimers()
    try {
      const held = vi.fn((_path: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')))
      }))
      vi.stubGlobal('fetch', held)
      let settled = 0
      const checks = Promise.all([hostKeyCheck('tllm-right'), statusKeyCheck('tllm-right'), hostKeyAccepted()].map((c) => c.finally(() => { settled++ })))
      await vi.advanceTimersByTimeAsync(KEY_CHECK_TIMEOUT_MS - 1)
      expect(settled).toBe(0)
      await vi.advanceTimersByTimeAsync(1)
      expect(await checks).toEqual(['unchecked', 'unchecked', true])
      expect(held).toHaveBeenCalledTimes(3)
    } finally {
      vi.useRealTimers()
    }
  })
})

// fetch throws before sending a header with a character outside ISO-8859-1 (here as the real one
// does, building the request's Headers), which read as a dropped connection: the prompt said to try
// again in a moment, and trying again never helped.
describe('a pasted key with a character no request header can carry', () => {
  it('is refused without a request, not "unchecked", by hostKeyCheck and statusKeyCheck alike', async () => {
    const realFetch = vi.fn(async (_path: string, init?: RequestInit) => {
      new Headers(init?.headers)
      return new Response(JSON.stringify({}), { status: 200 })
    })
    vi.stubGlobal('fetch', realFetch)
    expect(await hostKeyCheck('tllm-right\u201d')).toBe('refused')
    expect(await statusKeyCheck('\u200btllm-right')).toBe('refused')
    expect(realFetch).not.toHaveBeenCalled()
    // A character a header can carry is sent as before, for the daemon to judge.
    expect(await statusKeyCheck('tllm-right')).toBe('accepted')
    expect(realFetch).toHaveBeenCalledTimes(1)
  })
})

describe('statusKeyCheck', () => {
  it('a 401 from /status refuses the key; a 2xx or a 403, a remote-access token without config:read and so a key that works, takes it; no answer is "unchecked"', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: { code: 'unauthorized', message: 'A valid API key is required for non-local access.' } }), { status: 401 })))
    expect(await statusKeyCheck('tllm-typo')).toBe('refused')
    const scoped = refusal('forbidden', 'This access token is not allowed to do that.')
    vi.stubGlobal('fetch', scoped)
    expect(await statusKeyCheck('tllm-remote')).toBe('accepted')
    expect(scoped).toHaveBeenCalledWith('/api/v1/status', expect.objectContaining({ headers: expect.objectContaining({ 'X-TurboLLM-Auth': 'tllm-remote' }) }))
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({}), { status: 200 })))
    expect(await statusKeyCheck('tllm-right')).toBe('accepted')
    vi.stubGlobal('fetch', vi.fn(async () => new Response('Service Unavailable', { status: 503 })))
    expect(await statusKeyCheck('tllm-mine')).toBe('unchecked')
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch') }))
    expect(await statusKeyCheck('tllm-mine')).toBe('unchecked')
    expect(localStorage.getItem('tllm.authToken')).toBeNull()
  })
})
