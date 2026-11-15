// What POST /messages is sent: `replyAudio` appears only when asked for, so every other send's body is what it was.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { sendMessage } from './chat-api'

const fetchMock = vi.fn<typeof fetch>()
beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock)
  fetchMock.mockImplementation(async () => new Response(new ReadableStream({ start: (c) => c.close() }), { status: 200 }))
})
afterEach(() => {
  vi.unstubAllGlobals()
  fetchMock.mockReset()
})

async function sentBody(...args: Parameters<typeof sendMessage> extends [infer _C, infer _T, infer _S, ...infer Rest] ? Rest : never): Promise<Record<string, unknown>> {
  for await (const _ of sendMessage('c1', 'hi', new AbortController().signal, ...args)) { /* drain */ }
  return JSON.parse(String(fetchMock.mock.calls[0][1]?.body))
}

describe('sendMessage replyAudio', () => {
  it('is sent as true when asked for, beside the clips', async () => {
    const body = await sentBody(undefined, undefined, undefined, undefined, undefined, undefined, undefined, ['data:audio/wav;base64,AA'], true)
    expect(body.replyAudio).toBe(true)
    expect(body.audio).toEqual(['data:audio/wav;base64,AA'])
  })

  it('is left out when false or absent: the body has no such key', async () => {
    const withFalse = await sentBody(undefined, undefined, undefined, undefined, undefined, undefined, undefined, ['data:audio/wav;base64,AA'], false)
    expect('replyAudio' in withFalse).toBe(false)
    fetchMock.mockClear()
    const plain = await sentBody()
    expect('replyAudio' in plain).toBe(false)
    expect(plain).toEqual({ content: 'hi' })
  })
})
