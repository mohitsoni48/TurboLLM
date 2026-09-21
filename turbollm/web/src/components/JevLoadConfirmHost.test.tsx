// ADR-434 (i)(3): the confirmation names what a Jev load is about to interrupt, in the user's
// own words — "a reply in "Kitchen test"", not "1 active chat". It is mounted at the app level
// because the screen that fires the load (ModelDetailDialog) closes itself immediately.
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { JevLoadConfirmHost } from './JevLoadConfirmHost'
import { useJevLoadStore, type LoadOptions } from '../stores/jev-load'
import type { ActiveWork } from '../lib/types'

const h = vi.hoisted(() => ({
  confirmLoad: vi.fn(),
  track: vi.fn(),
}))

// The dialog runs no mutation of its own: "Load anyway" is the interrupted load, resumed
// (ADR-436 (6)).
vi.mock('../lib/model-loader', () => ({
  useConfirmedLoad: () => h.confirmLoad,
}))
vi.mock('../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/api')>()
  return { ...actual, track: (...a: unknown[]) => h.track(...a) }
})

const TARGET = {
  key: 'jev-key',
  name: 'qwen3.5 4b nli v2',
  jev: { labels: [], nliTemplate: null, architecture: 'Qwen3_5ForSequenceClassification', verified: true },
}

function openConfirm(work: ActiveWork | null, opts: LoadOptions = {}) {
  useJevLoadStore.setState({ confirm: { target: TARGET, work, opts }, pendingJevKey: null })
}

beforeEach(() => {
  h.confirmLoad.mockReset()
  h.track.mockReset()
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

  // A routine has no name of its own — the activity probe labels it with its prompt, which can
  // be a whole paragraph. This dialog is a list of what stops, not a transcript.
  it('cuts a routine prompt down to one line', () => {
    openConfirm({
      items: [{
        kind: 'routine',
        id: 'r1',
        label: 'Check every open GitHub issue for a reproduction, summarise the ones that have one, and post the digest to Discord',
      }],
      engineGenerating: false,
    })
    render(<JevLoadConfirmHost />)
    expect(screen.getByText('the routine "Check every open GitHub issue for a reproduction, summarise…"')).toBeTruthy()
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

  it('loads anyway through the loader, carrying everything the caller asked for', async () => {
    const onSuccess = vi.fn()
    const onError = vi.fn()
    openConfirm({ items: [{ kind: 'chat', id: 'c1', label: 'Kitchen test' }], engineGenerating: false }, {
      overrides: { ctx: 8192 },
      onSuccess,
      onError,
    })
    render(<JevLoadConfirmHost />)

    await userEvent.click(screen.getByRole('button', { name: 'Load anyway' }))

    expect(h.track).toHaveBeenCalledWith('models', 'confirm_jev_load')
    expect(h.confirmLoad).toHaveBeenCalledTimes(1)
    expect(h.confirmLoad).toHaveBeenCalledWith(TARGET, { overrides: { ctx: 8192 }, onSuccess, onError })
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
    expect(h.confirmLoad).not.toHaveBeenCalled()
    expect(useJevLoadStore.getState().confirm).toBeNull()
    expect(useJevLoadStore.getState().pendingJevKey).toBeNull()
  })
})
