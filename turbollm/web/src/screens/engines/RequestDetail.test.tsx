// The request detail drawer fetches the entry's captured bodies (GET /api/v1/requests/:id), which
// the daemon sends only to this machine or a caller with a valid key: anyone else gets 403
// api_key_required (routes.ts REQUEST_BODIES_HOST_ONLY). The refusal used to be `forbidden`, and
// the drawer fell back to the bodyless row: its Request and Response tabs read "No body captured
// for this request" and nothing asked for the key. Runs the real api.ts client over a stubbed
// fetch, as api.host-key.test.ts does, so the key prompt's signal is the real one.
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RequestDetail } from './RequestDetail'
import { clearHostKeyNeeded, isHostKeyNeeded } from '../../lib/auth-signal'
import type { RequestLogEntry } from '../../lib/types'

vi.mock('../../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/api')>()
  return { ...actual, track: vi.fn() }
})

const ROW: RequestLogEntry = {
  id: 'r1', ts: Date.parse('2026-09-08T12:00:00Z'), source: 'anthropic', harness: 'claude_code',
  codeSessionId: 's1', modelKey: 'qwen3-8b', remote: null, stream: true,
  params: {}, counts: { messages: 2, tools: 1, systemChars: 0 },
  status: 200, error: null, timings: { ttftMs: 120, durationMs: 900 },
  tokens: { prompt: 10, completion: 5, promptTps: 100, genTps: 50 }, finishReason: 'stop',
  bodies: null,
}
const REFUSAL = 'Captured prompts and responses can only be read on this machine or with a valid API key.'

function answer(status: number, body: unknown) {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status })))
}

beforeEach(() => clearHostKeyNeeded())
afterEach(() => vi.unstubAllGlobals())

describe('RequestDetail', () => {
  it('a body refused for want of a key says a key is needed and opens the key prompt, not "No body captured"', async () => {
    answer(403, { error: { code: 'api_key_required', message: REFUSAL } })
    render(<RequestDetail entry={ROW} onClose={() => {}} captureBodies />)
    await userEvent.click(await screen.findByRole('button', { name: 'request' }))
    expect(await screen.findByText(new RegExp(`${REFUSAL} Enter your key`))).toBeInTheDocument()
    expect(screen.queryByText('No body captured for this request.')).toBeNull()
    expect(isHostKeyNeeded()).toBe(true)
    await userEvent.click(screen.getByRole('button', { name: 'response' }))
    expect(screen.getByText(new RegExp(`${REFUSAL} Enter your key`))).toBeInTheDocument()
  })

  it('an entry served with its bodies shows them, and one served without says none was captured', async () => {
    answer(200, { entry: { ...ROW, bodies: { request: '{"messages":[]}', response: '{"content":"done"}' } } })
    const { unmount } = render(<RequestDetail entry={ROW} onClose={() => {}} captureBodies />)
    await userEvent.click(await screen.findByRole('button', { name: 'response' }))
    expect(await screen.findByText(/"content": "done"/)).toBeInTheDocument()
    unmount()

    answer(200, { entry: ROW })
    render(<RequestDetail entry={ROW} onClose={() => {}} captureBodies />)
    await userEvent.click(await screen.findByRole('button', { name: 'request' }))
    expect(await screen.findByText('No body captured for this request.')).toBeInTheDocument()
    expect(isHostKeyNeeded()).toBe(false)
  })
})
