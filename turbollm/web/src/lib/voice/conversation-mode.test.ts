import { describe, expect, it } from 'vitest'
import {
  CONVERSATION_OFF,
  applyConversation,
  reduceConversation,
  type ConversationEvent,
  type ConversationPhase,
  type ConversationState,
} from './conversation-mode'

const on = (phase: ConversationPhase): ConversationState => ({ on: true, phase })

/** Run one event and return [next state, effect types in order]. */
function step(state: ConversationState, event: ConversationEvent): [ConversationState, string[]] {
  const t = reduceConversation(state, event)
  return [t.state, t.effects.map((e) => e.type)]
}

/** Drive a whole turn as a script of events, collecting every effect. */
function run(script: ConversationEvent[], from: ConversationState = CONVERSATION_OFF): { state: ConversationState; effects: string[] } {
  let state = from
  const effects: string[] = []
  for (const event of script) {
    const t = reduceConversation(state, event)
    state = t.state
    effects.push(...t.effects.map((e) => e.type))
  }
  return { state, effects }
}

const TURN: ConversationEvent[] = [
  { type: 'start' },
  { type: 'clip-ended' },
  { type: 'message-sent' },
  { type: 'reply-done' },
  { type: 'speak-done' },
]

describe('the hands-free turn', () => {
  it('walks record -> transcribe -> generate -> speak -> record again, with the mode on throughout', () => {
    const phases: ConversationPhase[] = []
    let state = CONVERSATION_OFF
    for (const event of TURN) {
      state = applyConversation(state, event)
      expect(state.on).toBe(true)
      phases.push(state.phase)
    }
    expect(phases).toEqual(['recording', 'transcribing', 'generating', 'speaking', 'recording'])
  })

  it('opens the mic on start and again only after the reply has been read to the end', () => {
    expect(run(TURN).effects).toEqual(['start-recording', 'start-recording'])
  })

  it('keeps the mic shut while the reply is still speaking, so it cannot record TurboLLM itself', () => {
    // During speaking, no start-recording effect may come from any event other than speak-done, an explicit tap or start.
    for (const event of TURN) {
      const [, effects] = step(on('speaking'), event)
      if (event.type === 'speak-done' || event.type === 'start') continue
      expect(effects).not.toContain('start-recording')
    }
  })
})

describe('barge-in: a tap on the mic', () => {
  it('while the reply is speaking stops the speech and starts listening at once', () => {
    const [state, effects] = step(on('speaking'), { type: 'interrupt' })
    expect(state).toEqual(on('recording'))
    expect(effects).toEqual(['stop-speaking', 'start-recording'])
  })

  it('while the reply is still being written stops that reply, then listens (the mode stays on)', () => {
    const [state, effects] = step(on('generating'), { type: 'interrupt' })
    expect(state).toEqual(on('recording'))
    expect(effects).toEqual(['stop-reply', 'start-recording'])
  })

  it('while a clip is being transcribed drops the transcription and listens again', () => {
    const [state, effects] = step(on('transcribing'), { type: 'interrupt' })
    expect(state).toEqual(on('recording'))
    expect(effects).toEqual(['cancel-recording', 'start-recording'])
  })

  it('between turns (idle, mode on) starts the next turn', () => {
    const [state, effects] = step(on('idle'), { type: 'interrupt' })
    expect(state).toEqual(on('recording'))
    expect(effects).toEqual(['start-recording'])
  })

  it('while already recording changes nothing (the screen finishes the live clip)', () => {
    const [state, effects] = step(on('recording'), { type: 'interrupt' })
    expect(state).toEqual(on('recording'))
    expect(effects).toEqual([])
  })

  it('with the mode off does nothing', () => {
    expect(step(CONVERSATION_OFF, { type: 'interrupt' })).toEqual([CONVERSATION_OFF, []])
  })
})

describe('turning the mode off', () => {
  it('cancels an open recording', () => {
    const [state, effects] = step(on('recording'), { type: 'stop' })
    expect(state).toEqual(CONVERSATION_OFF)
    expect(effects).toEqual(['cancel-recording'])
  })

  it('cancels a transcription in progress', () => {
    const [state, effects] = step(on('transcribing'), { type: 'stop' })
    expect(state).toEqual(CONVERSATION_OFF)
    expect(effects).toEqual(['cancel-recording'])
  })

  it('stops the speech when off arrives mid-read-aloud', () => {
    const [state, effects] = step(on('speaking'), { type: 'stop' })
    expect(state).toEqual(CONVERSATION_OFF)
    expect(effects).toEqual(['stop-speaking'])
  })

  it('leaves a reply that is still being written to finish: it is the normal chat again', () => {
    const [state, effects] = step(on('generating'), { type: 'stop' })
    expect(state).toEqual(CONVERSATION_OFF)
    expect(effects).toEqual([])
  })

  it('is a no-op when already off', () => {
    expect(step(CONVERSATION_OFF, { type: 'stop' })).toEqual([CONVERSATION_OFF, []])
  })
})

describe('restart from anywhere', () => {
  it('start while speaking stops the old speech before opening the mic', () => {
    const [state, effects] = step(on('speaking'), { type: 'start' })
    expect(state).toEqual(on('recording'))
    expect(effects).toEqual(['stop-speaking', 'start-recording'])
  })

  it('start while a reply is being written stops it first', () => {
    expect(step(on('generating'), { type: 'start' })[1]).toEqual(['stop-reply', 'start-recording'])
  })

  it('start while already recording ends that clip first, so it is never sent twice', () => {
    const [state, effects] = step(on('recording'), { type: 'start' })
    expect(state).toEqual(on('recording'))
    expect(effects).toEqual(['cancel-recording', 'start-recording'])
  })
})

describe('a failure ends the turn, never the mode', () => {
  // The review's first finding: every failure path used to return to the same idle that "mode off" is.
  const FAILURES: Array<[string, ConversationEvent[]]> = [
    ['a clip with no speech in it', [{ type: 'start' }, { type: 'clip-empty' }]],
    ['a transcription that came back empty or failed', [{ type: 'start' }, { type: 'clip-ended' }, { type: 'clip-empty' }]],
    ['a send that was refused', [{ type: 'start' }, { type: 'clip-ended' }, { type: 'send-failed' }]],
    ['a send refused after the message was handed over', [{ type: 'start' }, { type: 'clip-ended' }, { type: 'message-sent' }, { type: 'send-failed' }]],
    ['a reply that never started or failed', [{ type: 'start' }, { type: 'clip-ended' }, { type: 'message-sent' }, { type: 'reply-failed' }]],
    ['a reply that cannot be read aloud', [...TURN.slice(0, 3), { type: 'speak-failed' }]],
    ['speech that broke off', [...TURN.slice(0, 4), { type: 'speak-failed' }]],
  ]
  for (const [what, script] of FAILURES) {
    it(`${what}: phase idle, mode still on`, () => {
      const { state } = run(script)
      expect(state).toEqual(on('idle'))
    })
  }

  it('the next tap after a failed turn starts a fresh one', () => {
    const { state, effects } = run([{ type: 'start' }, { type: 'clip-empty' }, { type: 'interrupt' }])
    expect(state).toEqual(on('recording'))
    expect(effects).toEqual(['start-recording', 'start-recording'])
  })

  it('a failed reply returns to idle without touching the speaker', () => {
    const { effects } = run([{ type: 'start' }, { type: 'clip-ended' }, { type: 'message-sent' }, { type: 'reply-failed' }])
    expect(effects).not.toContain('stop-speaking')
  })
})

describe('the audio route (a model that hears the clip itself)', () => {
  // useVoiceInput's attach() hands the clip over and only then lets the recorder go: the message is sent while the loop is
  // still in recording. That used to be ignored, and the recorder's release then read as an empty clip that killed the loop.
  it('hands the clip over straight from recording, and the recorder letting go afterwards changes nothing', () => {
    const { state } = run([{ type: 'start' }, { type: 'message-sent' }, { type: 'clip-empty' }])
    expect(state).toEqual(on('generating'))
  })

  it('the reply then speaks and the loop goes on', () => {
    const { state, effects } = run([{ type: 'start' }, { type: 'message-sent' }, { type: 'clip-empty' }, { type: 'reply-done' }, { type: 'speak-done' }])
    expect(state).toEqual(on('recording'))
    expect(effects).toEqual(['start-recording', 'start-recording'])
  })
})

describe('stray events are ignored', () => {
  it('late events from a finished turn do not move an idle machine', () => {
    for (const event of TURN.slice(1)) {
      const [state, effects] = step(on('idle'), event)
      expect(state).toEqual(on('idle'))
      expect(effects).toEqual([])
    }
  })

  it('nothing but start wakes a machine that is off', () => {
    for (const event of [...TURN.slice(1), { type: 'send-failed' } as ConversationEvent, { type: 'reply-failed' } as ConversationEvent]) {
      expect(step(CONVERSATION_OFF, event)).toEqual([CONVERSATION_OFF, []])
    }
  })

  it('a reply-done for a reply the user already barged into does not re-open the speaker', () => {
    // generating -> tap -> recording; the old reply then finishes anyway.
    const { state, effects } = run([
      { type: 'start' },
      { type: 'clip-ended' },
      { type: 'message-sent' },
      { type: 'interrupt' },
      { type: 'reply-done' },
    ])
    expect(state).toEqual(on('recording'))
    expect(effects).toEqual(['start-recording', 'stop-reply', 'start-recording'])
  })

  it('a clip-empty that arrives after the message was handed over does not end the turn', () => {
    expect(step(on('generating'), { type: 'clip-empty' })).toEqual([on('generating'), []])
    expect(step(on('speaking'), { type: 'clip-empty' })).toEqual([on('speaking'), []])
  })
})
