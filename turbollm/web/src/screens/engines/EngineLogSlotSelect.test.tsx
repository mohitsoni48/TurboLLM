// The engine-log views tail the primary engine by default; pool slots (keep-N, embedding, Laya) write logs of their
// own. The selector appears only when there is a slot to pick and reports the choice ('' = the primary engine).
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { EngineLogSlotSelect } from './EngineLogSlotSelect'

describe('EngineLogSlotSelect', () => {
  it('renders nothing while no pool slot is loaded', () => {
    const { container } = render(<EngineLogSlotSelect slots={[]} value="" onChange={() => {}} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('offers the primary engine and each slot, and reports the pick', () => {
    const onChange = vi.fn()
    render(<EngineLogSlotSelect slots={['embed-model', 'laya-model']} value="" onChange={onChange} />)
    const select = screen.getByLabelText('Log source') as HTMLSelectElement
    expect([...select.options].map((o) => o.value)).toEqual(['', 'embed-model', 'laya-model'])
    expect(select.value).toBe('')
    fireEvent.change(select, { target: { value: 'embed-model' } })
    expect(onChange).toHaveBeenCalledWith('embed-model')
  })
})
