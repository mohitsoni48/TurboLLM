import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ModelLoadMenu } from './ModelLoadMenu'

const { toastInfo } = vi.hoisted(() => ({ toastInfo: vi.fn() }))
vi.mock('../lib/api', () => ({ track: () => {} }))
vi.mock('./ui/sonner', () => ({ toast: { info: toastInfo } }))

const baseProps = { models: [], onLoad: () => {}, onEject: () => {}, screen: 'chat' as const }
const BLOCKED_REASON = 'Pick the model inside opencode.'

beforeEach(() => vi.clearAllMocks())

describe('ModelLoadMenu trigger', () => {
  it('starts closed and labels the trigger with the loaded model name', () => {
    render(<ModelLoadMenu {...baseProps} loadedKey="k" loadedName="Gemma 27B" />)
    expect(screen.getByText('Gemma 27B')).toBeInTheDocument()
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('stays closed and explains itself when blocked', async () => {
    render(<ModelLoadMenu {...baseProps} blockedReason={BLOCKED_REASON} />)
    await userEvent.click(screen.getByRole('button'))
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(toastInfo).toHaveBeenCalledWith(BLOCKED_REASON)
  })

  it.each([['{Enter}'], [' '], ['{ArrowDown}']])(
    'stays closed, shows no search box and explains itself on keyboard key %j when blocked',
    async (key) => {
      const onLoad = vi.fn()
      render(<ModelLoadMenu {...baseProps} onLoad={onLoad} blockedReason={BLOCKED_REASON} />)
      screen.getByRole('button').focus()
      await userEvent.keyboard(key)
      expect(screen.queryByRole('menu')).not.toBeInTheDocument()
      expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
      expect(toastInfo).toHaveBeenCalledWith(BLOCKED_REASON)
      expect(onLoad).not.toHaveBeenCalled()
    },
  )
})
