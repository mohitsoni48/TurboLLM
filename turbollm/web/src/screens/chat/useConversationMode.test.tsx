// useConversationMode against a fake recorder and a fake speaker. Each case below is one finding of the review of the first
// version of this hook: the machine is tested on its own in lib/voice/conversation-mode.test.ts, and these prove the wiring
// around it feeds it the right events (and never the wrong ones).
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useVoiceStore } from '../../stores/voice'
import { REPLY_START_MS, SPEAK_CLAIM_MS, useConversationMode } from './useConversationMode'
import type { VoicePhase } from './useVoiceInput'

// The speaker singleton, faked: a test decides what it is reading and when it goes silent.
const fakeSpeaker = vi.hoisted(() => {
  const listeners = new Set<() => void>()
  const state = {
    /** What activeId() answers: each call takes the next value, the last one repeats. */
    queue: [null] as Array<string | null>,
    stop: vi.fn(),
    listeners,
    notify: () => { for (const l of [...listeners]) l() },
    activeId: () => (state.queue.length > 1 ? state.queue.shift()! : state.queue[0]),
    subscribe: (l: () => void) => { listeners.add(l); return () => { listeners.delete(l) } },
  }
  return state
})
vi.mock('../../lib/voice/tts', () => ({ speaker: fakeSpeaker }))

interface Props { voicePhase: VoicePhase; replyStreaming: boolean; canListen: boolean; chatKey: string | null }

let visibility: DocumentVisibilityState = 'visible'

function setup(initial: Partial<Props> = {}) {
  const start = vi.fn(async () => {})
  const cancel = vi.fn()
  const stopReply = vi.fn()
  const props: Props = { voicePhase: 'idle', replyStreaming: false, canListen: true, chatKey: 'chat-1', ...initial }
  const hook = renderHook((p: Props) => useConversationMode({
    voice: { phase: p.voicePhase, start, cancel },
    replyStreaming: p.replyStreaming,
    canListen: p.canListen,
    chatKey: p.chatKey,
    stopReply,
  }), { initialProps: props })
  const update = (change: Partial<Props>) => {
    Object.assign(props, change)
    act(() => hook.rerender({ ...props }))
  }
  /** The recorder moves through phases as it really does. */
  const voice = (...phases: VoicePhase[]) => { for (const phase of phases) update({ voicePhase: phase }) }
  return { ...hook, start, cancel, stopReply, update, voice }
}

beforeEach(() => {
  visibility = 'visible'
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility })
  fakeSpeaker.queue = [null]
  fakeSpeaker.stop.mockClear()
  fakeSpeaker.listeners.clear()
  useVoiceStore.setState({ audioMode: 'ask', readAloud: 'off', autoStop: false })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('a hands-free turn', () => {
  it('records, sends, waits for the reply, hears it read out, and listens again', () => {
    vi.useFakeTimers()
    const h = setup()
    act(() => h.result.current.enable())
    expect(h.result.current.active).toBe(true)
    expect(h.start).toHaveBeenCalledTimes(1)
    h.voice('starting', 'recording')
    h.voice('transcribing')
    expect(h.result.current.phase).toBe('transcribing')
    act(() => h.result.current.emit({ type: 'message-sent' }))
    h.voice('idle')
    expect(h.result.current.phase).toBe('generating')
    h.update({ replyStreaming: true })
    fakeSpeaker.queue = ['reply-1']
    h.update({ replyStreaming: false })
    expect(h.result.current.phase).toBe('speaking')
    expect(h.start).toHaveBeenCalledTimes(1) // the mic stays shut while the reply is read out
    fakeSpeaker.queue = [null]
    act(() => fakeSpeaker.notify())
    expect(h.result.current.phase).toBe('recording')
    expect(h.start).toHaveBeenCalledTimes(2)
  })
})

describe('review finding 1: a failed turn ends the turn, not the mode', () => {
  it('a recording that held no speech (auto-stop dropped it) leaves the mode on and idle', () => {
    const h = setup()
    act(() => h.result.current.enable())
    h.voice('starting', 'recording', 'idle')
    expect(h.result.current.active).toBe(true)
    expect(h.result.current.phase).toBe('idle')
  })

  it('the next tap on the mic then starts a fresh turn', () => {
    const h = setup()
    act(() => h.result.current.enable())
    h.voice('starting', 'recording', 'idle')
    act(() => h.result.current.interrupt())
    expect(h.result.current.phase).toBe('recording')
    expect(h.start).toHaveBeenCalledTimes(2)
  })
})

describe('review finding 2: the audio route', () => {
  it('a clip attached as audio hands the message over from recording, and the recorder letting go does not end the loop', () => {
    const h = setup()
    act(() => h.result.current.enable())
    h.voice('starting', 'recording')
    act(() => h.result.current.emit({ type: 'message-sent' })) // attach() calls onClip first ...
    h.voice('idle') // ... and only then lets the recorder go
    expect(h.result.current.active).toBe(true)
    expect(h.result.current.phase).toBe('generating')
  })
})

describe('review finding 3: a transcription that gives nothing', () => {
  it('whisper returning no text (or failing) does not leave the loop stuck in transcribing', () => {
    const h = setup()
    act(() => h.result.current.enable())
    h.voice('starting', 'recording', 'transcribing')
    expect(h.result.current.phase).toBe('transcribing')
    h.voice('idle') // no onText: nothing was recognised
    expect(h.result.current.phase).toBe('idle')
    expect(h.result.current.active).toBe(true)
  })

  it('a tap while it is transcribing drops that clip and records again', () => {
    const h = setup()
    act(() => h.result.current.enable())
    h.voice('starting', 'recording', 'transcribing')
    act(() => h.result.current.interrupt())
    expect(h.cancel).toHaveBeenCalled()
    h.voice('idle') // the cancelled transcription lets go: that is not an empty clip
    expect(h.result.current.phase).toBe('recording')
    expect(h.start).toHaveBeenCalledTimes(2)
  })
})

describe('review finding 4: barge-in while the reply is being written', () => {
  it('stops that reply and listens, with the mode still on', () => {
    const h = setup()
    act(() => h.result.current.enable())
    h.voice('starting', 'recording', 'transcribing')
    act(() => h.result.current.emit({ type: 'message-sent' }))
    h.voice('idle')
    h.update({ replyStreaming: true })
    act(() => h.result.current.interrupt())
    expect(h.stopReply).toHaveBeenCalledTimes(1)
    expect(h.result.current.active).toBe(true)
    expect(h.result.current.phase).toBe('recording')
    expect(h.start).toHaveBeenCalledTimes(2) // the stopped reply was still streaming, and that did not fail the turn
  })
})

describe('review finding 5: a microphone that would not open', () => {
  it('denied permission (starting, then idle) fails the turn instead of leaving a dead recording state', () => {
    const h = setup()
    act(() => h.result.current.enable())
    h.voice('starting', 'idle')
    expect(h.result.current.phase).toBe('idle')
    expect(h.result.current.active).toBe(true)
  })

  it('no model ready: the mic is not opened for the turn', () => {
    const h = setup({ canListen: true })
    act(() => h.result.current.enable())
    h.voice('starting', 'recording', 'idle')
    h.update({ canListen: false })
    act(() => h.result.current.interrupt())
    expect(h.result.current.phase).toBe('idle')
    expect(h.start).toHaveBeenCalledTimes(1)
  })

  it('cannot be turned on without a model ready', () => {
    const h = setup({ canListen: false })
    act(() => h.result.current.enable())
    expect(h.result.current.active).toBe(false)
    expect(h.start).not.toHaveBeenCalled()
  })
})

describe('review finding 6: privacy', () => {
  it('never opens the mic while the tab is hidden', () => {
    visibility = 'hidden'
    const h = setup()
    act(() => h.result.current.enable())
    expect(h.start).not.toHaveBeenCalled()
    expect(h.result.current.phase).toBe('idle')
  })

  it('hiding the tab mid-clip ends the mode and drops the clip, instead of sending it and looping on', () => {
    const h = setup()
    act(() => h.result.current.enable())
    h.voice('starting', 'recording')
    visibility = 'hidden'
    act(() => { document.dispatchEvent(new Event('visibilitychange')) })
    expect(h.result.current.active).toBe(false)
    expect(h.cancel).toHaveBeenCalled()
  })

  it('does not reopen the mic after a reply once the tab is hidden', () => {
    vi.useFakeTimers()
    const h = setup()
    act(() => h.result.current.enable())
    h.voice('starting', 'recording', 'transcribing')
    act(() => h.result.current.emit({ type: 'message-sent' }))
    h.voice('idle')
    h.update({ replyStreaming: true })
    fakeSpeaker.queue = ['reply-1']
    h.update({ replyStreaming: false })
    expect(h.result.current.phase).toBe('speaking')
    visibility = 'hidden'
    act(() => { document.dispatchEvent(new Event('visibilitychange')) })
    expect(h.result.current.active).toBe(false)
    expect(h.start).toHaveBeenCalledTimes(1)
  })
})

describe('review finding 7: a message the chat refused', () => {
  it('stops waiting for a reply that never starts', () => {
    vi.useFakeTimers()
    const h = setup()
    act(() => h.result.current.enable())
    h.voice('starting', 'recording', 'transcribing')
    act(() => h.result.current.emit({ type: 'message-sent' }))
    h.voice('idle')
    expect(h.result.current.phase).toBe('generating')
    act(() => { vi.advanceTimersByTime(REPLY_START_MS + 10) })
    expect(h.result.current.phase).toBe('idle')
    expect(h.result.current.active).toBe(true)
  })

  it('does not give up on a reply that did start', () => {
    vi.useFakeTimers()
    const h = setup()
    act(() => h.result.current.enable())
    h.voice('starting', 'recording', 'transcribing')
    act(() => h.result.current.emit({ type: 'message-sent' }))
    h.voice('idle')
    h.update({ replyStreaming: true })
    act(() => { vi.advanceTimersByTime(REPLY_START_MS * 3) })
    expect(h.result.current.phase).toBe('generating')
  })

  it('a send that comes back refused ends the turn at once', () => {
    const h = setup()
    act(() => h.result.current.enable())
    h.voice('starting', 'recording', 'transcribing')
    act(() => h.result.current.emit({ type: 'message-sent' }))
    act(() => h.result.current.emit({ type: 'send-failed' }))
    expect(h.result.current.phase).toBe('idle')
    expect(h.result.current.active).toBe(true)
  })

  it('a reply that ends without being read aloud leaves the turn at idle after the grace', () => {
    vi.useFakeTimers()
    const h = setup()
    act(() => h.result.current.enable())
    h.voice('starting', 'recording', 'transcribing')
    act(() => h.result.current.emit({ type: 'message-sent' }))
    h.voice('idle')
    h.update({ replyStreaming: true })
    h.update({ replyStreaming: false }) // the speaker never picked the reply up
    act(() => { vi.advanceTimersByTime(SPEAK_CLAIM_MS + 200) })
    expect(h.result.current.phase).toBe('idle')
    expect(h.result.current.active).toBe(true)
  })
})

describe('review finding 8: the user’s voice settings are not rewritten', () => {
  it('turning the mode on leaves audioMode, readAloud and autoStop as they were, and says it is hands-free', () => {
    const h = setup()
    act(() => h.result.current.enable())
    expect(useVoiceStore.getState().audioMode).toBe('ask')
    expect(useVoiceStore.getState().readAloud).toBe('off')
    expect(useVoiceStore.getState().autoStop).toBe(false)
    expect(h.result.current.handsFree()).toBe(true)
    act(() => h.result.current.disable())
    expect(h.result.current.handsFree()).toBe(false)
  })
})

describe('the low findings', () => {
  it('moving to another chat ends the mode, but the chat this loop’s first message creates does not', () => {
    const h = setup({ chatKey: null })
    act(() => h.result.current.enable())
    h.update({ chatKey: 'created-by-the-first-message' })
    expect(h.result.current.active).toBe(true)
    h.update({ chatKey: 'another-chat' })
    expect(h.result.current.active).toBe(false)
  })

  it('a chat that is left for a new one (null) ends the mode too', () => {
    const h = setup({ chatKey: 'chat-1' })
    act(() => h.result.current.enable())
    h.update({ chatKey: null })
    expect(h.result.current.active).toBe(false)
  })

  it('a reply the speaker finished before the hook subscribed still lets the loop go on', () => {
    vi.useFakeTimers()
    const h = setup()
    act(() => h.result.current.enable())
    h.voice('starting', 'recording', 'transcribing')
    act(() => h.result.current.emit({ type: 'message-sent' }))
    h.voice('idle')
    h.update({ replyStreaming: true })
    fakeSpeaker.queue = ['reply-1', null] // reading when the stream ends, silent by the time speaking is subscribed to
    h.update({ replyStreaming: false })
    expect(h.result.current.phase).toBe('recording')
    expect(h.start).toHaveBeenCalledTimes(2)
  })

  it('leaving the screen with the mode on stops whatever the speaker is reading', () => {
    const h = setup()
    act(() => h.result.current.enable())
    fakeSpeaker.stop.mockClear()
    h.unmount()
    expect(fakeSpeaker.stop).toHaveBeenCalled()
  })

  it('turning the mode off cancels the clip being recorded', () => {
    const h = setup()
    act(() => h.result.current.enable())
    h.voice('starting', 'recording')
    act(() => h.result.current.disable())
    expect(h.cancel).toHaveBeenCalled()
    expect(h.result.current.active).toBe(false)
    h.voice('idle') // the cancelled recording lets go: nothing wakes the machine
    expect(h.result.current.phase).toBe('idle')
  })
})
