import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { Markdown } from './MessageBubble'

// Chat's StreamingBubble and Code's live commentary re-render <Markdown> on every token. Its
// custom renderers are element TYPES to React, so they must keep their identity across those
// renders — otherwise every code block, link and table is torn down and rebuilt per token (losing
// a sideways scroll, a selection, the copy button's state).
describe('Markdown — streaming re-renders', () => {
  it('reconciles code blocks, links and tables instead of remounting them on the next token', () => {
    let text = 'See [docs](https://example.com).\n\n```ts\nconst a = 1\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\nMore'
    const { container, rerender } = render(<Markdown streaming>{text}</Markdown>)
    const code = container.querySelector('code.block')
    const link = container.querySelector('a')
    const table = container.querySelector('table')
    expect(code && link && table).toBeTruthy()
    text += ' tok'
    rerender(<Markdown streaming>{text}</Markdown>)
    expect(container.querySelector('code.block')).toBe(code)
    expect(container.querySelector('a')).toBe(link)
    expect(container.querySelector('table')).toBe(table)
  })
})
