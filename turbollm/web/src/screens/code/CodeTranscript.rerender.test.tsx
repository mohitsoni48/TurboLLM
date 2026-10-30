import { act, render } from '@testing-library/react'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { CodeTranscript } from './CodeTranscript'
import type { Message } from '../../lib/chat-types'

// Every CodeToolLine reads the `/details` pref once per render — a pass-through counter on it
// measures how many finished tool lines (and their diff tables) re-render.
let toolLineRenders = 0
vi.mock('../../lib/code-display-prefs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/code-display-prefs')>()
  return {
    ...actual,
    useDisplayPref: (pref: Parameters<typeof actual.useDisplayPref>[0]) => {
      if (pref === 'details') toolLineRenders++
      return actual.useDisplayPref(pref)
    },
  }
})

const diff = '--- a/f.ts\n+++ b/f.ts\n@@ -1,2 +1,2 @@\n-old line\n+new line\n context'
const finishedTurns: Message[] = Array.from({ length: 10 }, (_, i) => [
  { id: `u${i}`, convId: 'c', seq: 2 * i, role: 'user', content: `task ${i}`, reasoning: '', attachments: [], textAttachments: [], toolCalls: [], stats: {}, createdAt: '', variantGroup: null, isActive: true, edited: false },
  { id: `a${i}`, convId: 'c', seq: 2 * i + 1, role: 'assistant', content: `Done ${i}.`, reasoning: '', attachments: [], textAttachments: [],
    toolCalls: [{ id: `t${i}`, name: 'edit', args: { path: `src/f${i}.ts` }, result: 'ok', diff }], stats: { totalMs: 1 }, createdAt: '', variantGroup: null, isActive: true, edited: false },
] as Message[]).flat()

describe('CodeTranscript — streaming a token', () => {
  it('does not re-render the finished turns (and their expanded diffs) on every token', () => {
    let addToken = () => {}
    function Screen() {
      const [text, setText] = useState('Working')
      addToken = () => setText((t) => t + ' on it')
      return <CodeTranscript messages={finishedTurns} liveAssistantId="live" live={{ timeline: [{ kind: 'text', text }], reasoning: '' }} />
    }
    render(<Screen />)
    expect(toolLineRenders).toBeGreaterThanOrEqual(10)
    toolLineRenders = 0
    for (let i = 0; i < 5; i++) act(() => addToken())
    expect(toolLineRenders).toBe(0)
  })
})
