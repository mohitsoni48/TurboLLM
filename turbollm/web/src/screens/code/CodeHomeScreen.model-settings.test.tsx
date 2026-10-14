// Issue 270: picking "settings" from the Code home composer's model picker must close the picker
// and leave the settings dialog open with focus inside it. Renders the REAL CodeHomeScreen, the REAL
// CodeComposer and the REAL ModelLoadMenu; only data hooks and heavy children are stubbed, and
// ModelDetailDialog is replaced by a stub that renders a real dialog.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ModelEntry } from '../../lib/types'

// Rendering the real screen takes several seconds on a loaded CI box, which the default 5000 ms test
// timeout does not cover; the assertions themselves stay unchanged.
vi.setConfig({ testTimeout: 30_000 })

beforeEach(() => {
  const store = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v) },
    removeItem: (k: string) => { store.delete(k) },
    clear: () => store.clear(),
  })
})

const MODEL_KEY = 'unsloth/Qwen3-8B-GGUF/Q8_0.gguf'
const loadableModel = {
  key: MODEL_KEY, name: 'Qwen3 8B', quant: 'Q8_0', incomplete: false, parseError: null,
  loaded: false, compatibleWithActiveEngine: true,
} as Partial<ModelEntry>

vi.mock('../../lib/queries', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/queries')>()
  return {
    ...actual,
    useStatus: () => ({ data: { engine: { state: 'running' } } }),
    useModels: () => ({ data: { models: [loadableModel] } }),
    useModelActions: () => ({
      load: { mutate: vi.fn(), isPending: false },
      eject: { mutate: vi.fn(), isPending: false },
    }),
    useGitBranch: () => ({ data: undefined }),
  }
})

vi.mock('../../lib/link-queries', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/link-queries')>()
  return { ...actual, useLinks: () => ({ data: [] }), useRemoteModels: () => ({ data: [] }) }
})

vi.mock('../../lib/code-queries', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/code-queries')>()
  return { ...actual, useCodeStats: () => ({ data: undefined }) }
})

vi.mock('../../lib/useIsDesktop', () => ({ useIsDesktop: () => true }))

vi.mock('../chat/ConversationSidebar', () => ({ ConversationSidebar: () => null }))
vi.mock('../engines/FsBrowser', () => ({ FsBrowser: () => null }))
vi.mock('./CodeActivityHeatmap', () => ({ CodeActivityHeatmap: () => null }))
vi.mock('../models/ModelDetailDialog', async () => {
  const { Dialog, DialogContent, DialogTitle } = await import('../../components/ui/dialog')
  return {
    ModelDetailDialog: ({ modelKey, onClose }: { modelKey: string | null; onClose: () => void }) => (
      <Dialog open={!!modelKey} onOpenChange={(open) => { if (!open) onClose() }}>
        <DialogContent>
          <DialogTitle>Settings {modelKey}</DialogTitle>
          <input aria-label="Context length" />
        </DialogContent>
      </Dialog>
    ),
  }
})

let CodeHomeScreen: typeof import('./CodeHomeScreen').CodeHomeScreen

// The cold import transforms the whole screen tree, which starves for tens of seconds under load;
// it gets its own hook timeout so no test timeout has to cover it.
beforeAll(async () => {
  ;({ CodeHomeScreen } = await import('./CodeHomeScreen'))
}, 120_000)

async function renderScreen() {
  return render(<MemoryRouter><CodeHomeScreen /></MemoryRouter>)
}

// Radix hands focus back to the trigger by calling trigger.focus() directly, and the open dialog's
// focus trap later pulls focus away again, so only a spy on that call separates a hand-off from a
// focus steal.
async function openPicker() {
  const trigger = await screen.findByRole('button', { name: /load a model/i })
  const triggerFocus = vi.spyOn(trigger, 'focus')
  await userEvent.click(trigger)
  const row = await screen.findByRole('menuitem', { name: /qwen3 8b/i })
  return { row, triggerFocus }
}

// jsdom cannot show a real focus steal or the soft keyboard; that stays a live check (plan Task 9 step 3).
async function expectSettingsDialogOpenAndPickerNeverRefocused(triggerFocus: { mock: { calls: unknown[] } }) {
  const dialog = await screen.findByRole('dialog', { name: `Settings ${MODEL_KEY}` })
  await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument())
  await waitFor(() => expect(dialog).toContainElement(document.activeElement as HTMLElement))
  await new Promise((resolve) => setTimeout(resolve, 0)) // the focus scope's unmount auto-focus is deferred
  expect(triggerFocus.mock.calls).toHaveLength(0)
  await userEvent.keyboard('8192')
  expect(screen.getByLabelText('Context length')).toHaveValue('8192')
  await userEvent.keyboard('{Escape}')
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
}

describe('CodeHomeScreen — model settings hand-off from the composer picker', () => {
  afterEach(cleanup)

  it('Alt+click on a model row opens the settings dialog, closes the picker and never refocuses the picker trigger', async () => {
    await renderScreen()
    const { row, triggerFocus } = await openPicker()

    fireEvent.click(row, { altKey: true })

    await expectSettingsDialogOpenAndPickerNeverRefocused(triggerFocus)
  })

  it('the sliders button opens the settings dialog, closes the picker and never refocuses the picker trigger', async () => {
    await renderScreen()
    const { triggerFocus } = await openPicker()

    fireEvent.click(screen.getByRole('button', { name: /configure qwen3 8b before loading/i }))

    await expectSettingsDialogOpenAndPickerNeverRefocused(triggerFocus)
  })
})
