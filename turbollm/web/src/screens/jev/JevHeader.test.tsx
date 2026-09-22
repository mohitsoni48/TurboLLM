// What is loaded, in one line (ADR-434 (c)). The labels come from the model's own config, so
// the header says so out loud — they are not a constant the app chose.
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { JevHeader } from './JevHeader'
import type { JevStatus } from '../../lib/types'

const JEV: JevStatus = {
  key: 'qwen3.5 4b nli v2|mlx-fp16|9012345678',
  name: 'qwen3.5 4b nli v2',
  labels: ['contradiction', 'entailment', 'neutral'],
  state: 'running',
  slot: 'primary',
}

const ENGINE = { name: 'vLLM 0.29', kind: 'vllm' }

describe('JevHeader', () => {
  it('names the model, the engine and the state', () => {
    render(<JevHeader jev={JEV} engine={ENGINE} onSwitch={vi.fn()} />)
    expect(screen.getByText('qwen3.5 4b nli v2 · vLLM 0.29 · running')).toBeTruthy()
  })

  it('says "Loading…" while the engine is still coming up', () => {
    render(<JevHeader jev={{ ...JEV, state: 'starting' }} engine={ENGINE} onSwitch={vi.fn()} />)
    expect(screen.getByText('qwen3.5 4b nli v2 · vLLM 0.29 · Loading…')).toBeTruthy()
  })

  it('says stopping while it is going away', () => {
    render(<JevHeader jev={{ ...JEV, state: 'stopping' }} engine={ENGINE} onSwitch={vi.fn()} />)
    expect(screen.getByText('qwen3.5 4b nli v2 · vLLM 0.29 · stopping')).toBeTruthy()
  })

  it('leaves out an engine it cannot name', () => {
    // A remote-access token scoped to models:use cannot read /status (ADR-422), so the
    // screen knows which Jev model is loaded but not what is running it. Better a shorter
    // chip than one with a gap where the engine should be.
    render(<JevHeader jev={JEV} engine={{ name: '', kind: '' }} onSwitch={vi.fn()} />)
    expect(screen.getByText('qwen3.5 4b nli v2 · running')).toBeTruthy()
  })

  it("credits the model for its own labels", () => {
    render(<JevHeader jev={JEV} engine={ENGINE} onSwitch={vi.fn()} />)
    expect(screen.getByText('Labels read from the model: contradiction, entailment, neutral')).toBeTruthy()
  })

  it('offers the way back to a chat model', async () => {
    const onSwitch = vi.fn()
    render(<JevHeader jev={JEV} engine={ENGINE} onSwitch={onSwitch} />)
    await userEvent.click(screen.getByRole('button', { name: 'Switch model' }))
    expect(onSwitch).toHaveBeenCalledTimes(1)
  })
})
