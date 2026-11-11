// The chat stream / reattach / stop orchestration, driven without React: a real
// QueryClient, a scripted frame generator in place of the SSE call.
import { QueryClient } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from './api'
import { chatKeys } from './chat-queries'
import type { ChatFrame, Conversation } from './chat-types'

const toastError = vi.fn()
const toastInfo = vi.fn()
vi.mock('../components/ui/sonner', () => ({ toast: Object.assign((m: string) => toastInfo(m), { error: (m: string) => toastError(m) }) }))

const followCalls: { convId: string; first: unknown }[] = []
let script: (convId: string, signal: AbortSignal) => AsyncGenerator<ChatFrame>
vi.mock('./chat-api', () => ({
  followChatTurn: (convId: string, first: unknown, signal: AbortSignal) => {
    followCalls.push({ convId, first })
    return script(convId, signal)
  },
  sendMessage: vi.fn(),
  continueConversation: vi.fn(),
}))

import { sendMessage } from './chat-api'
import { ChatSession } from './chat-session'

const META: ChatFrame = { event: 'meta', data: { userMessageId: 'u1', assistantMessageId: 'a1' } }

async function* frames(...list: (ChatFrame | Error)[]): AsyncGenerator<ChatFrame> {
  for (const f of list) {
    if (f instanceof Error) throw f
    yield f
  }
}

function makeSession(active: string | null = 'c1') {
  const qc = new QueryClient()
  const onActiveReplyDone = vi.fn()
  const session = new ChatSession({ qc, getActiveId: () => active, onActiveReplyDone })
  return { qc, session, onActiveReplyDone }
}

const conversation = (over: Partial<Conversation> = {}): Conversation => ({
  id: 'c1',
  messages: [{ id: 'a1', role: 'assistant', content: '', createdAt: 1 }],
  runningReplyId: 'a1',
  ...over,
} as Conversation)

beforeEach(() => {
  toastError.mockReset()
  toastInfo.mockReset()
  followCalls.length = 0
  vi.useRealTimers()
})

describe('ChatSession.follow', () => {
  it('opens a live entry at meta and grows it with reasoning and text deltas', async () => {
    const { session } = makeSession()
    const ac = new AbortController()
    const seen: string[] = []
    session.subscribe(() => seen.push(session.getSnapshot().liveByConv.c1?.content ?? '<none>'))
    const started = await session.follow('c1', ac, frames(
      META,
      { event: 'reasoning', data: { delta: 'hm' } },
      { event: 'delta', data: { delta: 'Hel' } },
      { event: 'delta', data: { delta: 'lo' } },
    ))
    expect(started).toBe(true)
    expect(seen).toContain('Hello')
    // The stream ended without done: the live view goes, the conversation has the rest.
    expect(session.getSnapshot().liveByConv.c1).toBeUndefined()
  })

  it('keeps the text so far across a repeated meta, and clears it on reset', async () => {
    const { session } = makeSession()
    let mid: unknown
    let afterReset: unknown
    const gen = (async function* () {
      yield META
      yield { event: 'delta', data: { delta: 'abc' } } as ChatFrame
      yield META
      mid = session.getSnapshot().liveByConv.c1?.content
      yield { event: 'reset', data: {} } as ChatFrame
      afterReset = session.getSnapshot().liveByConv.c1?.content
    })()
    await session.follow('c1', new AbortController(), gen)
    expect(mid).toBe('abc')
    expect(afterReset).toBe('')
  })

  it('on done patches the saved reply into the cache, drops live, and nudges the scroller for the open chat', async () => {
    vi.useFakeTimers()
    const { qc, session, onActiveReplyDone } = makeSession('c1')
    qc.setQueryData(chatKeys.detail('c1'), conversation())
    await session.follow('c1', new AbortController(), frames(
      META,
      { event: 'delta', data: { delta: 'Hi' } },
      { event: 'done', data: {} },
    ))
    const cached = qc.getQueryData<Conversation>(chatKeys.detail('c1'))
    expect(cached?.runningReplyId).toBeNull()
    expect(cached?.messages?.[0].content).toBe('Hi')
    expect(session.getSnapshot().liveByConv.c1).toBeUndefined()
    expect(session.getSnapshot().recentlyCompletedIds.has('c1')).toBe(false)
    vi.advanceTimersByTime(80)
    expect(onActiveReplyDone).toHaveBeenCalledTimes(1)
  })

  it('marks a chat that finished in the background as recently completed, until acknowledged', async () => {
    const { session, onActiveReplyDone } = makeSession('other')
    await session.follow('c1', new AbortController(), frames(META, { event: 'done', data: {} }))
    expect(session.getSnapshot().recentlyCompletedIds.has('c1')).toBe(true)
    expect(onActiveReplyDone).not.toHaveBeenCalled()
    session.acknowledgeCompleted('c1')
    expect(session.getSnapshot().recentlyCompletedIds.has('c1')).toBe(false)
  })

  it('toasts a daemon notice once per chat', async () => {
    const { session } = makeSession()
    const notice: ChatFrame = { event: 'notice', data: { message: 'no tools' } }
    await session.follow('c1', new AbortController(), frames(META, notice, notice))
    await session.follow('c1', new AbortController(), frames(META, notice))
    expect(toastInfo).toHaveBeenCalledTimes(1)
    await session.follow('c2', new AbortController(), frames(META, notice))
    expect(toastInfo).toHaveBeenCalledTimes(2)
  })

  it('an error frame clears live, toasts, and the reply is not followed again', async () => {
    const { session } = makeSession()
    await session.follow('c1', new AbortController(), frames(META, { event: 'error', data: { code: 'x', message: 'boom' } }))
    expect(toastError).toHaveBeenCalledWith('boom')
    expect(session.getSnapshot().liveByConv.c1).toBeUndefined()
    expect(session.hasFinished('a1')).toBe(true)
  })

  it('a turn refused before meta reports false, hands the error to refused, and leaves another turn live', async () => {
    const { session } = makeSession()
    // Another turn of the chat is live.
    const first = new AbortController()
    let release!: () => void
    const held = new Promise<void>((r) => { release = r })
    const running = session.follow('c1', first, (async function* () { yield META; await held })())
    await vi.waitFor(() => expect(session.getSnapshot().liveByConv.c1).toBeDefined())

    const refused = vi.fn()
    const err = new ApiError('generation_in_flight', 'busy', 409)
    const started = await session.follow('c1', new AbortController(), frames(err), { refused })
    expect(started).toBe(false)
    expect(refused).toHaveBeenCalledWith(err)
    expect(toastError).toHaveBeenCalledWith('busy')
    expect(session.getSnapshot().liveByConv.c1).toBeDefined()
    release()
    await running
  })

  it('a quiet attach that fails calls gaveUp instead of toasting', async () => {
    const { session } = makeSession()
    const gaveUp = vi.fn()
    await session.follow('c1', new AbortController(), frames(new Error('net')), { quiet: true, gaveUp })
    expect(gaveUp).toHaveBeenCalled()
    expect(toastError).not.toHaveBeenCalled()
  })

  it('claims the chat entry at meta and releases it when the turn ends', async () => {
    const { session } = makeSession()
    const ac = new AbortController()
    const p = session.follow('c1', ac, frames(META, { event: 'done', data: {} }))
    await p
    expect(session.isBusy('c1')).toBe(false)
  })
})

describe('ChatSession.stop', () => {
  it('puts the text so far into the cached reply, drops live, aborts the stream and reads again', async () => {
    const { qc, session } = makeSession()
    qc.setQueryData(chatKeys.detail('c1'), conversation())
    const invalidate = vi.spyOn(qc, 'invalidateQueries')
    const ac = new AbortController()
    let release!: () => void
    const held = new Promise<void>((r) => { release = r })
    const running = session.follow('c1', ac, (async function* () {
      yield META
      yield { event: 'delta', data: { delta: 'partial' } } as ChatFrame
      await held
    })())
    await vi.waitFor(() => expect(session.getSnapshot().liveByConv.c1?.content).toBe('partial'))

    await session.stop('c1', 'a1', () => Promise.resolve({ stopped: false }))
    const cached = qc.getQueryData<Conversation>(chatKeys.detail('c1'))
    expect(cached?.runningReplyId).toBeNull()
    expect(cached?.messages?.[0].content).toBe('partial')
    expect(session.getSnapshot().liveByConv.c1).toBeUndefined()
    expect(ac.signal.aborted).toBe(true)
    expect(invalidate).toHaveBeenCalledWith({ queryKey: chatKeys.detail('c1') })
    release()
    await running
  })

  it('leaves the live view and its Stop in place when the daemon refuses', async () => {
    const { session } = makeSession()
    const ac = new AbortController()
    let release!: () => void
    const held = new Promise<void>((r) => { release = r })
    const running = session.follow('c1', ac, (async function* () { yield META; await held })())
    await vi.waitFor(() => expect(session.getSnapshot().liveByConv.c1).toBeDefined())
    await session.stop('c1', 'a1', () => Promise.reject(new Error('x')))
    expect(toastError).toHaveBeenCalledWith('Could not stop the reply.')
    expect(session.getSnapshot().liveByConv.c1).toBeDefined()
    expect(ac.signal.aborted).toBe(false)
    release()
    await running
  })

  it('reads the chat a moment later when the daemon did stop it', async () => {
    vi.useFakeTimers()
    const { qc, session } = makeSession()
    const invalidate = vi.spyOn(qc, 'invalidateQueries')
    await session.stop('c1', 'a1', () => Promise.resolve({ stopped: true }))
    expect(invalidate).not.toHaveBeenCalled()
    vi.advanceTimersByTime(400)
    expect(invalidate).toHaveBeenCalledWith({ queryKey: chatKeys.detail('c1') })
  })
})

describe('ChatSession.abortAll / discard', () => {
  it('abortAll stops every followed stream and clears every live view', async () => {
    const { session } = makeSession()
    const a = new AbortController()
    const b = new AbortController()
    let release!: () => void
    const held = new Promise<void>((r) => { release = r })
    const pa = session.follow('c1', a, (async function* () { yield META; await held })())
    const pb = session.follow('c2', b, (async function* () { yield META; await held })())
    await vi.waitFor(() => expect(Object.keys(session.getSnapshot().liveByConv)).toHaveLength(2))
    session.abortAll()
    expect(a.signal.aborted && b.signal.aborted).toBe(true)
    expect(session.getSnapshot().liveByConv).toEqual({})
    release()
    await Promise.all([pa, pb])
  })

  it('discard lets go of one chat only', async () => {
    const { session } = makeSession()
    const a = new AbortController()
    let release!: () => void
    const held = new Promise<void>((r) => { release = r })
    const pa = session.follow('c1', a, (async function* () { yield META; await held })())
    await vi.waitFor(() => expect(session.getSnapshot().liveByConv.c1).toBeDefined())
    session.discard('c1')
    expect(a.signal.aborted).toBe(true)
    expect(session.getSnapshot().liveByConv.c1).toBeUndefined()
    release()
    await pa
  })
})

describe('ChatSession.attach', () => {
  it('follows the reply the daemon says runs, once', async () => {
    const { session } = makeSession()
    script = () => frames(META, { event: 'done', data: {} })
    session.attach('c1', 'a1', undefined, 1)
    await vi.waitFor(() => expect(session.hasFinished('a1')).toBe(true))
    expect(followCalls).toEqual([{ convId: 'c1', first: null }])
    // The reply ended here: a conversation read before the end still naming it is not followed again.
    session.attach('c1', 'a1', undefined, 2)
    expect(followCalls).toHaveLength(1)
  })

  it('does nothing without a running reply, or while the chat entry is held by the same reply', async () => {
    const { session } = makeSession()
    session.attach('c1', null, undefined, 1)
    session.attach(null, 'a1', undefined, 1)
    expect(followCalls).toHaveLength(0)

    let release!: () => void
    const held = new Promise<void>((r) => { release = r })
    script = () => (async function* () { yield META; await held })()
    session.attach('c1', 'a1', undefined, 1)
    await vi.waitFor(() => expect(session.getSnapshot().liveByConv.c1?.assistantId).toBe('a1'))
    session.attach('c1', 'a1', 'a1', 2)
    expect(followCalls).toHaveLength(1)
    // The daemon now names a newer reply than the one followed: that one is followed instead.
    script = () => frames(META)
    session.attach('c1', 'a2', 'a1', 3)
    expect(followCalls).toHaveLength(2)
    release()
  })

  it('after a give-up, tries again only once the conversation has been read again', async () => {
    const { session } = makeSession()
    script = () => frames(new Error('net'))
    session.attach('c1', 'a1', undefined, 1)
    await vi.waitFor(() => expect(followCalls).toHaveLength(1))
    await vi.waitFor(() => expect(session.isBusy('c1')).toBe(false))
    session.attach('c1', 'a1', undefined, 1)
    expect(followCalls).toHaveLength(1)
    session.attach('c1', 'a1', undefined, Date.now() + 1000)
    expect(followCalls).toHaveLength(2)
  })
})

describe('ChatSession lifecycle', () => {
  it('unmount lets go of followed streams but spares a send the daemon has not answered', async () => {
    const { session } = makeSession()
    const following = new AbortController()
    const posting = new AbortController()
    let release!: () => void
    const held = new Promise<void>((r) => { release = r })
    const p1 = session.follow('c1', following, (async function* () { yield META; await held })())
    const p2 = session.follow('c2', posting, (async function* () { yield META; await held })())
    await vi.waitFor(() => expect(Object.keys(session.getSnapshot().liveByConv)).toHaveLength(2))
    session.accepting(posting, () => {}) // the POST is out, unanswered
    session.mount()
    session.unmount()
    expect(following.signal.aborted).toBe(true)
    expect(posting.signal.aborted).toBe(false)
    release()
    await Promise.all([p1, p2])
  })

  it('a send the daemon takes after the screen has gone is let go of at once', () => {
    const { session } = makeSession()
    const ac = new AbortController()
    const accepted = vi.fn()
    const onAccepted = session.accepting(ac, accepted)
    session.mount()
    session.unmount()
    onAccepted()
    expect(accepted).toHaveBeenCalled()
    expect(ac.signal.aborted).toBe(true)
  })
})

describe('ChatSession.send', () => {
  const settings = { thinkingBudget: -1, reasoningEffort: 'medium', remoteModel: undefined } as unknown as Parameters<ChatSession['send']>[2]

  /** The arguments the page's POST was made with, once followChatTurn runs the send it was handed. */
  async function sentArgs(message: Parameters<ChatSession['send']>[1]): Promise<unknown[]> {
    script = () => frames()
    vi.mocked(sendMessage).mockClear()
    await makeSession().session.send('c1', message, settings)
    const first = followCalls[0].first as (accepted: () => void) => unknown
    first(() => {})
    return vi.mocked(sendMessage).mock.calls[0]
  }

  it('forwards the message\'s audio clips to sendMessage, after the acceptance callback', async () => {
    const args = await sentArgs({ text: 'hi', images: ['data:image/png;base64,II'], audio: ['data:audio/wav;base64,AA'], docContext: '', textAttachmentNames: [] })
    expect(args[0]).toBe('c1')
    expect(args[1]).toBe('hi')
    expect(args[3]).toEqual(['data:image/png;base64,II'])
    expect(typeof args[9]).toBe('function')
    expect(args[10]).toEqual(['data:audio/wav;base64,AA'])
  })

  it('passes no audio when the message has none', async () => {
    const args = await sentArgs({ text: 'hi', images: [], docContext: '', textAttachmentNames: [] })
    expect(args[10]).toBeUndefined()
  })
})
