// The daemon refuses a host-only setting (PATCH /api/v1/settings) and "Always Allow" on a tool
// call with 403 api_key_required when this browser presented no valid key. With requireApiKey off
// nothing 401s, so this code is the only thing that can raise the key prompt for, say, the owner
// of a Docker install at http://localhost:6996, who arrives from the bridge address. Before, both
// clients only threw, and the Settings screen and the approval bar showed a toast with nowhere to
// enter the key. Mirrors code-api.test.ts's localStorage/fetch stubbing.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError, hostKeyAccepted, saveSettings } from './api'
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

// App.tsx checks a key pasted into that prompt with this before closing it.
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
