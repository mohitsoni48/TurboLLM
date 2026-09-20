// ADR-434 (i)(3): the confirmation names what a Jev load is about to interrupt, in the user's
// own words — "a reply in "Kitchen test"", not "1 active chat". It is mounted at the app level
// because the screen that fires the load (ModelDetailDialog) closes itself immediately.
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { JevLoadConfirmHost } from './JevLoadConfirmHost'
import { useJevLoadStore } from '../stores/jev-load'
import type { ActiveWork } from '../lib/types'

const h = vi.hoisted(() => ({
  loadMutate: vi.fn(),
  track: vi.fn(),
  toastError: vi.fn(),
}))

vi.mock('../lib/queries', () => ({ useModelActions: () => ({ load: { mutate: h.loadMutate, isPending: false } }) }))
vi.mock('../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/api')>()
  return { ...actual, track: (...a: unknown[]) => h.track(...a) }
})
vi.mock('./ui/sonner', () => ({ toast: { error: (...a: unknown[]) => h.toastError(...a), success: vi.fn() } }))

const TARGET = { key: 'jev-key', name: 'qwen3.5 4b nli v2', isJev: true }

function openConfirm(work: ActiveWork | null, overrides?: { ctx: number }) {
  useJevLoadStore.setState({ confirm: { target: TARGET, work, overrides }, pendingJevKey: null })
}

beforeEach(() => {
  h.loadMutate.mockReset()
  h.track.mockReset()
  h.toastError.mockReset()
  useJevLoadStore.setState({ confirm: null, pendingJevKey: null })
})

describe('JevLoadConfirmHost', () => {
  it('renders nothing until a load asks for confirmation', () => {
    render(<JevLoadConfirmHost />)
    expect(screen.queryByRole('alertdialog')).toBeNull()
  })

  it('names the model in the title', () => {
    openConfirm({ items: [], engineGenerating: true })
    render(<JevLoadConfirmHost />)
    expect(screen.getByText('Load qwen3.5 4b nli v2?')).toBeTruthy()
    expect(screen.getByText('Loading a Jev model stops the running model and interrupts:')).toBeTruthy()
  })

  it('names each kind of work in the words the user would use', () => {
    openConfirm({
      items: [
        { kind: 'chat', id: 'c1', label: 'Kitchen test' },
        { kind: 'code', id: 's1', label: 'Fix the scanner' },
        { kind: 'routine', id: 'r1', label: 'Morning digest' },
      ],
      engineGenerating: false,
    })
    render(<JevLoadConfirmHost />)
    expect(screen.getByText('a reply in "Kitchen test"')).toBeTruthy()
    expect(screen.getByText('a Code turn in "Fix the scanner"')).toBeTruthy()
    expect(screen.getByText('the routine "Morning digest"')).toBeTruthy()
  })

  it('names a generation that has no item of its own', () => {
    openConfirm({ items: [], engineGenerating: true })
    render(<JevLoadConfirmHost />)
    expect(screen.getByText('a request an API client is generating')).toBeTruthy()
  })

  it('does not claim an API generation when it already named the work', () => {
    openConfirm({ items: [{ kind: 'chat', id: 'c1', label: 'Kitchen test' }], engineGenerating: true })
    render(<JevLoadConfirmHost />)
    expect(screen.queryByText('a request an API client is generating')).toBeNull()
  })

  it('is honest when the daemon could not be asked', () => {
    openConfirm(null)
    render(<JevLoadConfirmHost />)
    expect(screen.getByText("TurboLLM couldn't check what is running right now — loading may interrupt it.")).toBeTruthy()
  })

  it('loads anyway, claiming the toast first and carrying the overrides through', async () => {
    openConfirm({ items: [{ kind: 'chat', id: 'c1', label: 'Kitchen test' }], engineGenerating: false }, { ctx: 8192 })
    render(<JevLoadConfirmHost />)

    await userEvent.click(screen.getByRole('button', { name: 'Load anyway' }))

    expect(h.track).toHaveBeenCalledWith('models', 'confirm_jev_load')
    expect(h.loadMutate).toHaveBeenCalledTimes(1)
    expect(h.loadMutate.mock.calls[0][0]).toEqual({ key: 'jev-key', overrides: { ctx: 8192 } })
    expect(useJevLoadStore.getState().pendingJevKey).toBe('jev-key')
    expect(useJevLoadStore.getState().confirm).toBeNull()
  })

  it('does not also record a cancel when the dialog closes itself after Load anyway', async () => {
    openConfirm({ items: [], engineGenerating: true })
    render(<JevLoadConfirmHost />)

    await userEvent.click(screen.getByRole('button', { name: 'Load anyway' }))

    expect(h.track).toHaveBeenCalledTimes(1)
    expect(h.track).not.toHaveBeenCalledWith('models', 'cancel_jev_load')
  })

  it('still records the cancel of a later dialog, after an earlier one was confirmed', async () => {
    openConfirm({ items: [], engineGenerating: true })
    const { rerender } = render(<JevLoadConfirmHost />)
    await userEvent.click(screen.getByRole('button', { name: 'Load anyway' }))
    h.track.mockReset()

    openConfirm({ items: [], engineGenerating: true })
    rerender(<JevLoadConfirmHost />)
    await userEvent.keyboard('{Escape}')

    expect(h.track).toHaveBeenCalledWith('models', 'cancel_jev_load')
    expect(useJevLoadStore.getState().confirm).toBeNull()
  })

  it('cancels without loading anything', async () => {
    openConfirm({ items: [{ kind: 'chat', id: 'c1', label: 'Kitchen test' }], engineGenerating: false })
    render(<JevLoadConfirmHost />)

    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    expect(h.track).toHaveBeenCalledWith('models', 'cancel_jev_load')
    expect(h.loadMutate).not.toHaveBeenCalled()
    expect(useJevLoadStore.getState().confirm).toBeNull()
    expect(useJevLoadStore.getState().pendingJevKey).toBeNull()
  })

  it('surfaces a failed load, so a Jev load cannot fail silently', async () => {
    openConfirm({ items: [], engineGenerating: true })
    render(<JevLoadConfirmHost />)
    await userEvent.click(screen.getByRole('button', { name: 'Load anyway' }))

    const { onError } = h.loadMutate.mock.calls[0][1] as { onError: (e: unknown) => void }
    onError(new Error('boom'))

    expect(h.toastError).toHaveBeenCalledWith('Could not load model: check the engine logs on the Engines screen.')
  })

  it('relays the daemon\'s own words when it gave a reason', async () => {
    const { ApiError } = await import('../lib/api')
    openConfirm({ items: [], engineGenerating: true })
    render(<JevLoadConfirmHost />)
    await userEvent.click(screen.getByRole('button', { name: 'Load anyway' }))

    const { onError } = h.loadMutate.mock.calls[0][1] as { onError: (e: unknown) => void }
    onError(new ApiError('engine_start_failed', 'vLLM is not installed.', 409))

    expect(h.toastError).toHaveBeenCalledWith('Could not load model: vLLM is not installed.')
  })
})
