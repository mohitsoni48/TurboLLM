// The thin React binding over ChatSession: it re-renders on the session's changes, hands the
// session the open chat's reattach inputs, and ties mount/unmount to the screen's lifetime.
import { act, renderHook } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createElement, type ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import type { ChatFrame } from './chat-types'

const followCalls: string[] = []
vi.mock('./chat-api', () => ({
  followChatTurn: (convId: string) => {
    followCalls.push(convId)
    return (async function* (): AsyncGenerator<ChatFrame> { yield { event: 'meta', data: { userMessageId: 'u', assistantMessageId: 'a1' } }; yield { event: 'done', data: {} } })()
  },
  sendMessage: vi.fn(),
  continueConversation: vi.fn(),
}))
vi.mock('../components/ui/sonner', () => ({ toast: Object.assign(vi.fn(), { error: vi.fn() }) }))

import { useChatSession } from './use-chat-session'

const wrapper = ({ children }: { children: ReactNode }) =>
  createElement(QueryClientProvider, { client: new QueryClient() }, children)

describe('useChatSession', () => {
  it('attaches to the reply the daemon says runs, and re-renders with its live state', async () => {
    const { result } = renderHook(
      () => useChatSession({ activeId: 'c1', runningReplyId: 'a1', convReadAt: 1, onActiveReplyDone: () => {} }),
      { wrapper },
    )
    // The session notifies a burst of changes once more at its end, a task later.
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(followCalls).toEqual(['c1'])
    expect(Object.keys(result.current.liveByConv)).toEqual([])
    expect(result.current.session).toBeDefined()
  })

  it('shows the live entry a stream opens, to the open chat', async () => {
    const { result } = renderHook(
      () => useChatSession({ activeId: 'c9', runningReplyId: null, convReadAt: 0, onActiveReplyDone: () => {} }),
      { wrapper },
    )
    let release!: () => void
    const held = new Promise<void>((r) => { release = r })
    let running!: Promise<boolean>
    await act(async () => {
      running = result.current.session.follow('c9', new AbortController(), (async function* (): AsyncGenerator<ChatFrame> {
        yield { event: 'meta', data: { userMessageId: 'u', assistantMessageId: 'a9' } }
        await held
      })())
      await Promise.resolve()
    })
    expect(result.current.liveByConv.c9?.assistantId).toBe('a9')
    await act(async () => { release(); await running })
    expect(result.current.liveByConv.c9).toBeUndefined()
  })

  // A refreshed page attaching to a reply that waits for approval, through React: the daemon replays every frame so
  // far in one burst, and a render per frame is what the chat screen's own updates tipped into "Maximum update depth
  // exceeded". The hook alone does not throw, so this counts the renders instead. Outside act, as a real attach runs:
  // act batches renders itself and would hide a render per frame.
  it('renders a long replayed burst a few times, not once per frame, and ends on the waiting tool call', async () => {
    const env = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    const wasActEnv = env.IS_REACT_ACT_ENVIRONMENT
    env.IS_REACT_ACT_ENVIRONMENT = false
    const ac = new AbortController()
    try {
      let renders = 0
      const { result } = renderHook(
        () => { renders++; return useChatSession({ activeId: 'c5', runningReplyId: null, convReadAt: 0, onActiveReplyDone: () => {} }) },
        { wrapper },
      )
      const before = renders
      const burst: ChatFrame[] = [
        { event: 'meta', data: { userMessageId: 'u', assistantMessageId: 'a5' } },
        ...Array.from({ length: 400 }, () => ({ event: 'reasoning', data: { delta: 'x' } }) as ChatFrame),
        { event: 'tool_call', data: { id: 't1', name: 'run_code', args: { code: '2 + 2' }, status: 'awaiting_approval' } },
      ]
      void result.current.session.follow('c5', ac, (async function* () { yield* burst; await new Promise(() => {}) })())
      await new Promise((r) => setTimeout(r, 20))
      expect(renders - before).toBeLessThanOrEqual(3)
      expect(result.current.liveByConv.c5?.timeline.find((b) => b.kind === 'tool')).toMatchObject({ call: { status: 'awaiting_approval' } })
    } finally {
      ac.abort()
      env.IS_REACT_ACT_ENVIRONMENT = wasActEnv
    }
  })

  it('lets go of followed streams when the screen unmounts', async () => {
    const { result, unmount } = renderHook(
      () => useChatSession({ activeId: 'c2', runningReplyId: null, convReadAt: 0, onActiveReplyDone: () => {} }),
      { wrapper },
    )
    const ac = new AbortController()
    let release!: () => void
    const held = new Promise<void>((r) => { release = r })
    let running!: Promise<boolean>
    await act(async () => {
      running = result.current.session.follow('c2', ac, (async function* (): AsyncGenerator<ChatFrame> {
        yield { event: 'meta', data: { userMessageId: 'u', assistantMessageId: 'a2' } }
        await held
      })())
      await Promise.resolve()
    })
    unmount()
    expect(ac.signal.aborted).toBe(true)
    release()
    await running
  })
})
