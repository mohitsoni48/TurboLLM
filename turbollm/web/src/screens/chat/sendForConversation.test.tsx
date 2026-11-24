import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { sendForConversation, type ConversationSendResult } from './sendForConversation'
import { useConversationMode } from './useConversationMode'

vi.mock('../../lib/voice/tts', () => ({
  speaker: { stop: vi.fn(), activeId: () => null, subscribe: () => () => {} },
}))

function deferred() {
  let resolve!: (result: ConversationSendResult) => void
  const promise = new Promise<ConversationSendResult>((done) => { resolve = done })
  return { promise, resolve }
}

function setup() {
  const start = vi.fn()
  const stopReply = vi.fn()
  const hook = renderHook(() => useConversationMode({
    voice: { phase: 'recording', start, cancel: vi.fn() },
    replyStreaming: false,
    canListen: true,
    chatKey: 'chat-1',
    stopReply,
    enabled: true,
  }))
  act(() => hook.result.current.enable())
  return { ...hook, start, stopReply }
}

describe('hands-free send completion', () => {
  it('keeps the new recording after a prefill send is aborted by barge-in', async () => {
    const h = setup()
    const old = deferred()
    let pending!: Promise<void>
    act(() => { pending = sendForConversation(h.result.current, () => old.promise) })
    expect(h.result.current.phase).toBe('generating')
    act(() => h.result.current.interrupt())
    expect(h.stopReply).toHaveBeenCalledOnce()
    expect(h.result.current.phase).toBe('recording')
    await act(async () => {
      old.resolve({ started: false, aborted: true })
      await pending
    })
    expect(h.result.current.phase).toBe('recording')
    expect(h.result.current.active).toBe(true)
  })

  it('uses each result when overlapping sends settle in reverse order', async () => {
    const emit = vi.fn()
    const older = deferred()
    const newer = deferred()
    const first = sendForConversation({ emit }, () => older.promise)
    const second = sendForConversation({ emit }, () => newer.promise)
    newer.resolve({ started: true, aborted: false })
    await second
    older.resolve({ started: false, aborted: true })
    await first
    expect(emit.mock.calls.map(([event]) => event.type)).toEqual(['message-sent', 'message-sent'])
  })

  it('still ends the waiting turn when a send is genuinely refused', async () => {
    const h = setup()
    await act(async () => {
      await sendForConversation(h.result.current, async () => ({ started: false, aborted: false }))
    })
    expect(h.result.current.phase).toBe('idle')
    expect(h.result.current.active).toBe(true)
  })

  it('does not report failure after streaming started', async () => {
    const emit = vi.fn()
    await sendForConversation({ emit }, async () => ({ started: true, aborted: false }))
    expect(emit).toHaveBeenCalledExactlyOnceWith({ type: 'message-sent' })
  })
})
