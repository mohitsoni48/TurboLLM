// Fork from before an instruction (GitHub issue 323): on the same user messages Revert is on, handing over the id of the
// message just before it, the last one the new session keeps.
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { CodeTranscript } from './CodeTranscript'
import type { Message } from '../../lib/chat-types'

function message(role: 'user' | 'assistant', content: string, id: string): Message {
  return {
    id, convId: 'c1', seq: 0, role, content, reasoning: '',
    attachments: [], textAttachments: [], toolCalls: [], stats: {}, createdAt: '2026-11-17T00:00:00Z',
    variantGroup: null, isActive: true, edited: false,
  }
}

const transcript = [message('user', 'add login', 'u1'), message('assistant', 'done', 'a1'), message('user', 'add tests', 'u2')]

describe('CodeTranscript — Fork from before this message', () => {
  it('forks up to the message before the instruction, and is not on the first one', () => {
    const onFork = vi.fn()
    render(<CodeTranscript messages={transcript} onRevert={() => {}} onFork={onFork} />)
    const buttons = screen.getAllByLabelText('Fork from before this message')
    expect(buttons).toHaveLength(1)
    fireEvent.click(buttons[0])
    expect(onFork).toHaveBeenCalledWith('a1')
  })

  it('is not offered while a run is live, or when the screen gives no handler', () => {
    const { unmount } = render(<CodeTranscript messages={transcript} onFork={vi.fn()} live={{ timeline: [], reasoning: '' }} />)
    expect(screen.queryByLabelText('Fork from before this message')).toBeNull()
    unmount()
    render(<CodeTranscript messages={transcript} />)
    expect(screen.queryByLabelText('Fork from before this message')).toBeNull()
  })
})
