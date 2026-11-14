import { describe, expect, it } from 'vitest'
import {
  applyConversation,
  reduceConversation,
  type ConversationEffect,
  type ConversationEvent,
  type ConversationPhase,
} from './conversation-mode'

/** Run one event and return [next phase, effect types in order]. */
function step(phase: ConversationPhase, event: ConversationEvent): [ConversationPhase, string[]] {
  const t = reduceConversation(phase, event)
  return [t.phase, t.effects.map((e) => e.type)]
}

/** Drive a whole turn as a script of events, collecting every effect. */
function run(script: ConversationEvent[], from: ConversationPhase = 'idle'): { phase: ConversationPhase; effects: string[] } {
  let phase = from
  const effects: string[] = []
  for (const event of script) {
    const t = reduceConversation(phase, event)
    phase = t.phase
    effects.push(...t.effects.map((e) => e.type))
  }
  return { phase, effects }
}

const TURN: ConversationEvent[] = [
  { type: 'start' },
  { type: 'clip-ended' },
  { type: 'message-sent' },
  { type: 'reply-done' },
  { type: 'speak-done' },
]

describe('the hands-free turn', () => {
  it('walks record -> transcribe -> generate -> speak -> record again', () => {
    const phases: ConversationPhase[] = []
    let phase: ConversationPhase = 'idle'
    for (const event of TURN) {
      phase = applyConversation(phase, event)
      phases.push(phase)
    }
    expect(phases).toEqual(['recording', 'transcribing', 'generating', 'speaking', 'recording'])
  })

  it('opens the mic on start and again only after the reply has been read to the end', () => {
    const { effects } = run(TURN)
    expect(effects).toEqual(['start-recording', 'start-recording'])
  })

  it('keeps the mic shut while the reply is still speaking, so it cannot record TurboLLM itself', () => {
    // During speaking, no start-recording effect may be produced by any event other than
    // speak-done or an explicit interrupt.
    for (const event of TURN) {
      const [, effects] = step('speaking', event)
      if (event.type === 'speak-done' || event.type === 'interrupt' || event.type === 'start') continue
      expect(effects).not.toContain('start-recording')
    }
  })
})

describe('barge-in', () => {
  it('a tap while the reply is speaking stops the speech and starts listening at once', () => {
    const [phase, effects] = step('speaking', { type: 'interrupt' })
    expect(phase).toBe('recording')
    expect(effects).toEqual(['stop-speaking', 'start-recording'])
  })

  it('a tap while the reply is still generating starts listening without waiting for it', () => {
    const [phase, effects] = step('generating', { type: 'interrupt' })
    expect(phase).toBe('recording')
    expect(effects).toEqual(['start-recording'])
  })

  it('a tap while already recording changes nothing (the clip is already live)', () => {
    const [phase, effects] = step('recording', { type: 'interrupt' })
    expect(phase).toBe('recording')
    expect(effects).toEqual([])
  })
})

describe('turning the mode off', () => {
  it('cancels an open recording and detaches mid-turn work', () => {
    const [phase, effects] = step('recording', { type: 'stop' })
    expect(phase).toBe('idle')
    expect(effects).toEqual(['cancel-recording', 'detach'])
  })

  it('stops the speech and detaches when off arrives mid-read-aloud', () => {
    const [phase, effects] = step('speaking', { type: 'stop' })
    expect(phase).toBe('idle')
    expect(effects).toEqual(['stop-speaking', 'detach'])
  })

  it('only detaches when the turn is between mic and speaker', () => {
    for (const phase of ['transcribing', 'generating'] as const) {
      const [next, effects] = step(phase, { type: 'stop' })
      expect(next).toBe('idle')
      expect(effects).toEqual(['detach'])
    }
  })

  it('is a no-op from idle', () => {
    const [phase, effects] = step('idle', { type: 'stop' })
    expect(phase).toBe('idle')
    expect(effects).toEqual([])
  })
})

describe('restart from anywhere', () => {
  it('start while speaking stops the old speech before opening the mic', () => {
    const [phase, effects] = step('speaking', { type: 'start' })
    expect(phase).toBe('recording')
    expect(effects).toEqual(['stop-speaking', 'start-recording'])
  })

  it('start while already recording ends that clip first, so it is never sent twice', () => {
    const [phase, effects] = step('recording', { type: 'start' })
    expect(phase).toBe('recording')
    expect(effects).toEqual(['cancel-recording', 'start-recording'])
  })
})

describe('failure paths end the turn, not the mode', () => {
  it('a clip with no speech in it goes back to idle and is never transcribed', () => {
    const { phase, effects } = run([{ type: 'start' }, { type: 'clip-empty' }])
    expect(phase).toBe('idle')
    expect(effects).toEqual(['start-recording'])
  })

  it('a cancelled clip can never reach transcribing (no empty message sends)', () => {
    const [phase] = step('idle', { type: 'message-sent' })
    expect(phase).toBe('idle')
  })

  it('a failed send returns to idle, ready for the next turn', () => {
    const { phase } = run([{ type: 'start' }, { type: 'clip-ended' }, { type: 'send-failed' }])
    expect(phase).toBe('idle')
  })

  it('a failed reply returns to idle without speaking', () => {
    const { phase, effects } = run([{ type: 'start' }, { type: 'clip-ended' }, { type: 'message-sent' }, { type: 'reply-failed' }])
    expect(phase).toBe('idle')
    expect(effects).not.toContain('stop-speaking')
  })

  it('a reply that cannot be read aloud waits for the user instead of looping silently', () => {
    const { phase, effects } = run([...TURN.slice(0, 4), { type: 'speak-failed' }])
    expect(phase).toBe('idle')
    expect(effects).toEqual(['start-recording'])
  })
})

describe('stray events are ignored', () => {
  it('late events from a finished turn do not move an idle machine', () => {
    for (const event of TURN.slice(1)) {
      const [phase, effects] = step('idle', event)
      expect(phase).toBe('idle')
      expect(effects).toEqual([])
    }
  })

  it('a reply-done for a reply the user already barged into does not re-open the speaker', () => {
    // generating -> interrupt -> recording; the old reply then finishes anyway.
    const { phase, effects } = run([
      { type: 'start' },
      { type: 'clip-ended' },
      { type: 'message-sent' },
      { type: 'interrupt' },
      { type: 'reply-done' },
    ])
    expect(phase).toBe('recording')
    expect(effects).toEqual(['start-recording', 'start-recording'])
  })
})
