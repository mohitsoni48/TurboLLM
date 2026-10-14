import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ModelLoadMenu } from './ModelLoadMenu'
import { Dialog, DialogContent, DialogTitle } from './ui/dialog'
import type { LinkRecord } from '../lib/link-api'
import type { RemoteModelRow } from '../lib/remote-models'
import type { ModelEntry } from '../lib/types'

const { track, toastInfo } = vi.hoisted(() => ({ track: vi.fn(), toastInfo: vi.fn() }))
vi.mock('../lib/api', () => ({ track }))
vi.mock('./ui/sonner', () => ({ toast: { info: toastInfo } }))

const GEMMA = 'google/gemma-27b-GGUF/gemma-27b-Q4_K_M.gguf'
const QWEN35 = 'unsloth/Qwen3-35B-GGUF/Q4_K_M.gguf'
const QWEN8 = 'unsloth/Qwen3-8B-GGUF/Q8_0.gguf'

const LOCAL = [
  { key: GEMMA, name: 'Gemma 27B', quant: 'Q4_K_M' },
  { key: QWEN35, name: 'Qwen3 35B', quant: 'Q4_K_M' },
  { key: QWEN8, name: 'Qwen3 8B', quant: 'Q8_0' },
].map((m) => ({ ...m, incomplete: false, parseError: null, loaded: false })) as unknown as ModelEntry[]

function link(over: Record<string, unknown>): LinkRecord {
  return {
    baseUrl: 'https://rig.trycloudflare.com',
    machineId: 'm1',
    machineIdChanged: false,
    grantedCapabilities: ['models:use'],
    linkApiVersion: 1,
    status: 'online',
    lastSeenAt: null,
    lastError: null,
    ...over,
  } as unknown as LinkRecord
}

const remoteRow = (loaded: boolean): RemoteModelRow => ({
  linkId: 'l1',
  machine: 'workstation',
  model: { key: 'qwen3-35b', name: 'Qwen3 35B', quant: 'Q4_K_M', nativeCtx: 262144, vision: false, loaded },
})

type MenuProps = Parameters<typeof ModelLoadMenu>[0]

function menu(props: Partial<MenuProps> = {}) {
  const handlers = { onLoad: vi.fn(), onEject: vi.fn(), onSettings: vi.fn() }
  const element = (extra: Partial<MenuProps> = {}) => (
    <ModelLoadMenu models={LOCAL} loadedKey={null} loadedName={null} screen="chat" {...handlers} {...props} {...extra} />
  )
  return { ...handlers, element }
}

const trigger = () => document.querySelector('[aria-haspopup="menu"]') as HTMLElement

async function openMenu(props: Partial<MenuProps> = {}) {
  const harness = menu(props)
  render(harness.element())
  await userEvent.click(trigger())
  expect(screen.getByRole('menu')).toBeInTheDocument()
  return harness
}

const expectClosed = () => waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument())

beforeEach(() => vi.clearAllMocks())
afterEach(() => vi.restoreAllMocks())

describe('picking', () => {
  it('loads the clicked model, closes the menu and returns focus to the trigger', async () => {
    const { onLoad } = await openMenu()
    await userEvent.click(screen.getByText('Gemma 27B'))
    expect(onLoad).toHaveBeenCalledWith(GEMMA)
    expect(track).toHaveBeenCalledWith('chat', 'load_model')
    await expectClosed()
    await waitFor(() => expect(trigger()).toHaveFocus())
  })

  it('closes without reloading when the clicked model is already loaded', async () => {
    const { onLoad } = await openMenu({ loadedKey: GEMMA, loadedName: 'Gemma 27B' })
    await userEvent.click(screen.getAllByText('Gemma 27B')[1])
    expect(onLoad).not.toHaveBeenCalled()
    await expectClosed()
  })

  it('explains a disabled remote row and keeps the menu open', async () => {
    const { onLoad } = await openMenu({
      links: [link({ id: 'l1', name: 'workstation' })],
      remoteModels: [remoteRow(false)],
    })
    await userEvent.click(screen.getByTitle(/not loaded on workstation/i))
    expect(toastInfo).toHaveBeenCalledWith(expect.stringMatching(/not loaded on workstation/i))
    expect(onLoad).not.toHaveBeenCalled()
    expect(screen.getByRole('menu')).toBeInTheDocument()
  })

  it('opens settings on Alt+click instead of loading, and closes', async () => {
    const { onLoad, onSettings } = await openMenu()
    fireEvent.click(screen.getByText('Gemma 27B'), { altKey: true })
    expect(onSettings).toHaveBeenCalledWith(GEMMA)
    expect(track).toHaveBeenCalledWith('chat', 'open_model_load_settings')
    expect(onLoad).not.toHaveBeenCalled()
    await expectClosed()
  })

  it('opens settings from the sliders button without loading, and closes', async () => {
    const { onLoad, onSettings } = await openMenu()
    await userEvent.click(screen.getByRole('button', { name: /configure qwen3 8b before loading/i }))
    expect(onSettings).toHaveBeenCalledTimes(1)
    expect(onSettings).toHaveBeenCalledWith(QWEN8)
    expect(onLoad).not.toHaveBeenCalled()
    await expectClosed()
  })

  it('ejects and closes', async () => {
    const { onEject } = await openMenu({ loadedKey: GEMMA, loadedName: 'Gemma 27B' })
    await userEvent.click(screen.getByText('Eject model'))
    expect(onEject).toHaveBeenCalledTimes(1)
    expect(track).toHaveBeenCalledWith('chat', 'eject_model')
    await expectClosed()
  })
})

describe('settings hand-off', () => {
  function Host(props: Partial<MenuProps>) {
    const [settingsKey, setSettingsKey] = useState<string | null>(null)
    return (
      <>
        <ModelLoadMenu
          models={LOCAL} loadedKey={null} loadedName={null} screen="chat"
          onLoad={() => {}} onEject={() => {}} {...props}
          onSettings={(key) => setSettingsKey(key)}
        />
        <Dialog open={!!settingsKey} onOpenChange={(o) => { if (!o) setSettingsKey(null) }}>
          <DialogContent>
            <DialogTitle>Settings for {settingsKey}</DialogTitle>
            <input aria-label="Context length" />
          </DialogContent>
        </Dialog>
      </>
    )
  }

  async function expectDialogHasFocusAndKeyboard(triggerFocus: MockInstance) {
    const dialog = await screen.findByRole('dialog')
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    // FocusScope defers its unmount auto-focus, and Radix calls trigger.focus() directly: only a spy
    // on that call tells the build with the hand-off fix from the one without it.
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)))
    expect(triggerFocus).not.toHaveBeenCalled()
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true))
    await userEvent.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  }

  async function openHost() {
    render(<Host />)
    await userEvent.click(trigger())
    return vi.spyOn(trigger(), 'focus')
  }

  it('hands focus to the dialog after Alt+click', async () => {
    const triggerFocus = await openHost()
    fireEvent.click(screen.getByText('Gemma 27B'), { altKey: true })
    await expectDialogHasFocusAndKeyboard(triggerFocus)
  })

  it('hands focus to the dialog after the sliders button', async () => {
    const triggerFocus = await openHost()
    await userEvent.click(screen.getByRole('button', { name: /configure qwen3 8b before loading/i }))
    await expectDialogHasFocusAndKeyboard(triggerFocus)
  })
})

const searchBox = () => screen.getByRole('combobox', { name: 'Search models' })

function pretendTouchDevice() {
  vi.spyOn(window, 'matchMedia').mockImplementation(
    (q: string) =>
      ({
        matches: q === '(pointer: coarse)', media: q, onchange: null,
        addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
        dispatchEvent: () => false,
      }) as unknown as MediaQueryList,
  )
}

describe('search box', () => {
  it('is shown on open with the Library placeholder and focused on desktop', async () => {
    await openMenu()
    expect(searchBox()).toHaveAttribute('placeholder', 'Search models')
    expect(searchBox()).toHaveFocus()
  })

  it('is not auto-focused on a touch device', async () => {
    pretendTouchDevice()
    await openMenu()
    expect(searchBox()).not.toHaveFocus()
  })

  it('takes focus out of a composer on a touch device so typing never reaches the message', async () => {
    pretendTouchDevice()
    const harness = menu()
    render(<><textarea aria-label="Message" />{harness.element()}</>)
    const composer = screen.getByLabelText('Message')
    composer.focus()
    await userEvent.click(trigger())
    expect(screen.getByRole('menu')).toBeInTheDocument()
    expect(composer).not.toHaveFocus()
    expect(searchBox()).not.toHaveFocus()
  })

  it('points aria-controls at the element holding the rows', async () => {
    await openMenu({ loadedKey: GEMMA, loadedName: 'Gemma 27B' })
    const list = document.getElementById(searchBox().getAttribute('aria-controls') ?? '')
    expect(list).not.toBeNull()
    expect(list).toContainElement(rowOf('Qwen3 8B'))
    expect(list).toContainElement(screen.getByText('Eject model'))
    expect(list).not.toContainElement(searchBox())
  })

  it('is shown even with no models', async () => {
    await openMenu({ models: [] })
    expect(searchBox()).toBeInTheDocument()
    expect(screen.getByText('No models found')).toBeInTheDocument()
  })

  it('never appears for a blocked picker', async () => {
    render(menu({ blockedReason: 'Pick inside opencode.' }).element())
    await userEvent.click(trigger())
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
  })

  it.each([['q'], ['e']])('keeps focus and the typed letter %s in the box', async (letter) => {
    await openMenu({ loadedKey: GEMMA, loadedName: 'Gemma 27B' })
    await userEvent.keyboard(letter)
    expect(searchBox()).toHaveFocus()
    expect(searchBox()).toHaveValue(letter)
  })

  it('narrows the list by name and by several words', async () => {
    await openMenu()
    await userEvent.keyboard('qwen')
    expect(screen.getByText('Qwen3 35B')).toBeInTheDocument()
    expect(screen.getByText('Qwen3 8B')).toBeInTheDocument()
    expect(screen.queryByText('Gemma 27B')).not.toBeInTheDocument()
    await userEvent.keyboard(' 8b')
    expect(screen.queryByText('Qwen3 35B')).not.toBeInTheDocument()
    expect(screen.getByText('Qwen3 8B')).toBeInTheDocument()
  })

  it('says so when nothing matches', async () => {
    await openMenu()
    await userEvent.keyboard('zzz')
    expect(screen.getByText('No matching models')).toBeInTheDocument()
    expect(screen.queryByText('Gemma 27B')).not.toBeInTheDocument()
  })

  it('hides a non-matching machine group but keeps an offline one named by the query', async () => {
    const online = { links: [link({ id: 'l1', name: 'workstation' })], remoteModels: [remoteRow(true)] }
    const { unmount } = render(menu(online).element())
    await userEvent.click(trigger())
    await userEvent.keyboard('gemma')
    expect(screen.queryByText('workstation')).not.toBeInTheDocument()
    unmount()

    const offline = {
      links: [link({ id: 'l1', name: 'workstation', status: 'unreachable', lastError: 'workstation did not answer.' })],
      remoteModels: [],
    }
    render(menu(offline).element())
    await userEvent.click(trigger())
    await userEvent.keyboard('workst')
    expect(screen.getByText('workstation did not answer.')).toBeInTheDocument()
  })

  it('shows the empty-local hint only while the query is blank', async () => {
    await openMenu({ models: [], links: [link({ id: 'l1', name: 'workstation' })], remoteModels: [remoteRow(true)] })
    expect(screen.getByText('No local models found.')).toBeInTheDocument()
    await userEvent.keyboard('zzz')
    expect(screen.queryByText('No local models found.')).not.toBeInTheDocument()
    expect(screen.getByText('No matching models')).toBeInTheDocument()
  })

  it('keeps Eject visible while filtering', async () => {
    await openMenu({ loadedKey: GEMMA, loadedName: 'Gemma 27B' })
    await userEvent.keyboard('zzz')
    expect(screen.getByText('Eject model')).toBeInTheDocument()
  })

  it('closes on Escape and reopens with an empty box', async () => {
    await openMenu()
    await userEvent.keyboard('qwen{Escape}')
    await expectClosed()
    await userEvent.click(trigger())
    expect(searchBox()).toHaveValue('')
  })

  it('keeps focus in the box when hovering Eject', async () => {
    await openMenu({ loadedKey: GEMMA, loadedName: 'Gemma 27B' })
    // Radix's modal layer sets pointer-events:none on <body>, where unhover lands.
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    await user.hover(screen.getByText('Eject model'))
    expect(searchBox()).toHaveFocus()
    await user.unhover(screen.getByText('Eject model'))
    expect(searchBox()).toHaveFocus()
  })
})

describe('shortcuts with focus in the box', () => {
  const seen = vi.fn()
  beforeEach(() => window.addEventListener('keydown', seen))
  afterEach(() => window.removeEventListener('keydown', seen))

  const reached = (key: string) => seen.mock.calls.map(([e]) => e as KeyboardEvent).filter((e) => e.key === key)

  it.each([['f'], ['n'], ['k'], ['d']])('lets Ctrl+%s reach the window', async (key) => {
    await openMenu()
    await userEvent.keyboard(`{Control>}${key}{/Control}`)
    expect(reached(key)[0]?.ctrlKey).toBe(true)
    expect(screen.getByRole('menu')).toBeInTheDocument()
    expect(searchBox()).toHaveValue('')
  })

  it('lets Meta+k reach the window', async () => {
    await openMenu()
    await userEvent.keyboard('{Meta>}k{/Meta}')
    expect(reached('k')[0]?.metaKey).toBe(true)
  })

  it('lets Alt+x reach the window', async () => {
    await openMenu()
    await userEvent.keyboard('{Alt>}x{/Alt}')
    expect(reached('x')[0]?.altKey).toBe(true)
  })

  it('keeps plain characters and Space inside the box', async () => {
    await openMenu()
    await userEvent.keyboard('q ')
    expect(reached('q')).toHaveLength(0)
    expect(reached(' ')).toHaveLength(0)
  })

  it('lets Escape reach the window', async () => {
    await openMenu()
    await userEvent.keyboard('{Escape}')
    expect(reached('Escape')).toHaveLength(1)
  })
})

describe('searching by source repo', () => {
  const withRepos = LOCAL.map((m, i) => ({
    ...m,
    key: ['gemma-27b|q4_k_m|16000000000', 'qwen3-35b|q4_k_m|13211155424', 'qwen3-8b|q8_0|8800000000'][i],
    sourceRepo: i === 0 ? 'google/gemma-27b-GGUF' : 'unsloth/Qwen3-GGUF',
  })) as unknown as ModelEntry[]

  it('finds models by the owner of their source repo', async () => {
    await openMenu({ models: withRepos })
    await userEvent.keyboard('unsloth')
    expect(screen.getByText('Qwen3 35B')).toBeInTheDocument()
    expect(screen.queryByText('Gemma 27B')).not.toBeInTheDocument()
  })

  it('does not match digits of the size in the model key', async () => {
    await openMenu({ models: withRepos })
    await userEvent.keyboard('132')
    expect(screen.queryByText('Qwen3 35B')).not.toBeInTheDocument()
    expect(screen.getByText('No matching models')).toBeInTheDocument()
  })
})

const REMOTE_ID = 'workstation/qwen3-35b'
const onlineLink = () => [link({ id: 'l1', name: 'workstation' })]
const activeRows = () => Array.from(document.querySelectorAll('[data-active]'))
const rowOf = (text: string, nth = 0) => screen.getAllByText(text)[nth].closest('[role="menuitem"]') as HTMLElement

describe('keyboard', () => {
  it('Enter loads the first match and closes', async () => {
    const { onLoad } = await openMenu()
    await userEvent.keyboard('qwen{Enter}')
    expect(onLoad).toHaveBeenCalledWith(QWEN35)
    expect(track).toHaveBeenCalledWith('chat', 'load_model')
    await expectClosed()
  })

  it('ArrowDown then Enter loads the second match', async () => {
    const { onLoad } = await openMenu()
    await userEvent.keyboard('qwen{ArrowDown}{Enter}')
    expect(onLoad).toHaveBeenCalledWith(QWEN8)
  })

  it('highlights the first match and exposes it as the active descendant', async () => {
    await openMenu()
    await userEvent.keyboard('qwen')
    const first = rowOf('Qwen3 35B')
    expect(activeRows()).toEqual([first])
    expect(searchBox()).toHaveAttribute('aria-activedescendant', first.id)
  })

  it('does nothing on Enter with a blank query, and picks the first row after ArrowDown', async () => {
    const { onLoad } = await openMenu()
    await userEvent.keyboard('{Enter}')
    expect(onLoad).not.toHaveBeenCalled()
    expect(screen.getByRole('menu')).toBeInTheDocument()
    await userEvent.keyboard('{ArrowDown}{Enter}')
    expect(onLoad).toHaveBeenCalledWith(GEMMA)
  })

  it('stays on the first row on ArrowUp', async () => {
    const { onLoad } = await openMenu()
    await userEvent.keyboard('qwen{ArrowUp}{Enter}')
    expect(onLoad).toHaveBeenCalledWith(QWEN35)
  })

  it('reaches Eject by arrowing past the last row', async () => {
    const { onLoad, onEject } = await openMenu({ loadedKey: GEMMA, loadedName: 'Gemma 27B' })
    await userEvent.keyboard('qwen{ArrowDown}{ArrowDown}{Enter}')
    expect(onEject).toHaveBeenCalledTimes(1)
    expect(track).toHaveBeenCalledWith('chat', 'eject_model')
    expect(onLoad).not.toHaveBeenCalled()
  })

  it('neither loads nor ejects on Enter when nothing matches', async () => {
    const { onLoad, onEject } = await openMenu({ loadedKey: GEMMA, loadedName: 'Gemma 27B' })
    await userEvent.keyboard('zzz{Enter}')
    expect(onLoad).not.toHaveBeenCalled()
    expect(onEject).not.toHaveBeenCalled()
  })

  it('explains a disabled row the user arrowed onto, on Enter, and keeps menu and query', async () => {
    const { onLoad } = await openMenu({ links: onlineLink(), remoteModels: [remoteRow(false)] })
    await userEvent.keyboard('workstation{ArrowDown}{Enter}')
    expect(toastInfo).toHaveBeenCalledWith(expect.stringMatching(/not loaded on workstation/i))
    expect(onLoad).not.toHaveBeenCalled()
    expect(screen.getByRole('menu')).toBeInTheDocument()
    expect(searchBox()).toHaveValue('workstation')
  })

  describe('disabled rows and the default highlight', () => {
    const remoteTwo = (): RemoteModelRow[] => [
      remoteRow(false),
      { ...remoteRow(true), model: { ...remoteRow(true).model, key: 'qwen3-8b', name: 'Qwen3 8B' } },
    ]
    const remoteOnly = () => ({ models: [], links: onlineLink(), remoteModels: remoteTwo() })

    it('Enter skips a disabled first match and loads the first pickable one', async () => {
      const { onLoad } = await openMenu(remoteOnly())
      await userEvent.keyboard('qwen')
      expect(activeRows()).toEqual([rowOf('Qwen3 8B')])
      await userEvent.keyboard('{Enter}')
      expect(onLoad).toHaveBeenCalledWith('workstation/qwen3-8b')
      expect(toastInfo).not.toHaveBeenCalled()
    })

    it('Enter is a silent no-op when every match is disabled', async () => {
      const { onLoad } = await openMenu({ models: [], links: onlineLink(), remoteModels: [remoteRow(false)] })
      await userEvent.keyboard('qwen')
      expect(activeRows()).toEqual([])
      expect(searchBox()).not.toHaveAttribute('aria-activedescendant')
      await userEvent.keyboard('{Enter}')
      expect(toastInfo).not.toHaveBeenCalled()
      expect(onLoad).not.toHaveBeenCalled()
      expect(screen.getByRole('menu')).toBeInTheDocument()
    })

    it('arrowing up onto the disabled row then Enter explains it and keeps the menu open', async () => {
      const { onLoad } = await openMenu(remoteOnly())
      await userEvent.keyboard('qwen{ArrowUp}{Enter}')
      expect(toastInfo).toHaveBeenCalledWith(expect.stringMatching(/not loaded on workstation/i))
      expect(onLoad).not.toHaveBeenCalled()
      expect(screen.getByRole('menu')).toBeInTheDocument()
    })

    it('hovering the disabled row then Enter explains it and keeps the menu open', async () => {
      const { onLoad } = await openMenu(remoteOnly())
      await userEvent.keyboard('qwen')
      await userEvent.hover(rowOf('Qwen3 35B'))
      await userEvent.keyboard('{Enter}')
      expect(toastInfo).toHaveBeenCalledWith(expect.stringMatching(/not loaded on workstation/i))
      expect(onLoad).not.toHaveBeenCalled()
      expect(screen.getByRole('menu')).toBeInTheDocument()
    })
  })

  it('opens settings on Alt+Enter for a local row', async () => {
    const { onLoad, onSettings } = await openMenu()
    await userEvent.keyboard('gemma')
    fireEvent.keyDown(searchBox(), { key: 'Enter', altKey: true })
    expect(onSettings).toHaveBeenCalledWith(GEMMA)
    expect(onLoad).not.toHaveBeenCalled()
  })

  it('ignores Alt on Enter for a remote row and loads it by its qualified id', async () => {
    const { onLoad, onSettings } = await openMenu({ links: onlineLink(), remoteModels: [remoteRow(true)] })
    await userEvent.keyboard('workstation')
    fireEvent.keyDown(searchBox(), { key: 'Enter', altKey: true })
    expect(onLoad).toHaveBeenCalledWith(REMOTE_ID)
    expect(onSettings).not.toHaveBeenCalled()
  })

  it('does nothing on Ctrl+Enter or Ctrl+ArrowDown, and keeps the menu open', async () => {
    const { onLoad } = await openMenu()
    await userEvent.keyboard('qwen')
    fireEvent.keyDown(searchBox(), { key: 'Enter', ctrlKey: true })
    fireEvent.keyDown(searchBox(), { key: 'Enter', metaKey: true })
    fireEvent.keyDown(searchBox(), { key: 'ArrowDown', ctrlKey: true })
    expect(onLoad).not.toHaveBeenCalled()
    expect(screen.getByRole('menu')).toBeInTheDocument()
    expect(activeRows()).toEqual([rowOf('Qwen3 35B')])
  })

  it('ignores Enter and arrows that belong to an IME composition', async () => {
    const { onLoad } = await openMenu()
    await userEvent.keyboard('qwen')
    fireEvent.keyDown(searchBox(), { key: 'Enter', isComposing: true })
    fireEvent.keyDown(searchBox(), { key: 'Enter', keyCode: 229 })
    fireEvent.keyDown(searchBox(), { key: 'ArrowDown', keyCode: 229 })
    expect(onLoad).not.toHaveBeenCalled()
    expect(activeRows()).toEqual([rowOf('Qwen3 35B')])
  })
})

describe('list changes under an open menu', () => {
  const withLink = { loadedKey: GEMMA, loadedName: 'Gemma 27B', links: onlineLink() }

  async function openAt(highlighted: string[], extra: Partial<MenuProps> = {}) {
    const harness = menu({ ...withLink, remoteModels: [remoteRow(true)], ...extra })
    const view = render(harness.element())
    await userEvent.click(trigger())
    await userEvent.keyboard(`qwen${highlighted.map((k) => `{${k}}`).join('')}`)
    return { ...harness, ...view }
  }

  it('falls back to the first remaining match, never Eject, when the highlighted remote row vanishes', async () => {
    const { onLoad, onEject, rerender, element } = await openAt(['ArrowDown', 'ArrowDown'])
    expect(activeRows()).toEqual([rowOf('Qwen3 35B', 1)])
    rerender(element({ remoteModels: [] }))
    expect(activeRows()).toEqual([rowOf('Qwen3 35B')])
    await userEvent.keyboard('{Enter}')
    expect(onLoad).toHaveBeenCalledWith(QWEN35)
    expect(onEject).not.toHaveBeenCalled()
  })

  it('falls back to the first remaining match when the highlighted local row is removed', async () => {
    const { onEject, rerender, element } = await openAt(['ArrowDown'])
    const withoutQwen8 = LOCAL.filter((m) => m.key !== QWEN8)
    rerender(element({ models: withoutQwen8 }))
    expect(activeRows()).toEqual([rowOf('Qwen3 35B')])
    await userEvent.keyboard('{Enter}')
    expect(onEject).not.toHaveBeenCalled()
  })

  it('highlights nothing, and Enter does nothing, when the list shrinks to zero', async () => {
    const { onLoad, onEject, rerender, element } = await openAt([])
    rerender(element({ models: [], remoteModels: [] }))
    expect(activeRows()).toEqual([])
    expect(searchBox()).not.toHaveAttribute('aria-activedescendant')
    await userEvent.keyboard('{Enter}')
    expect(onLoad).not.toHaveBeenCalled()
    expect(onEject).not.toHaveBeenCalled()
  })

  it('keeps Eject highlighted when the user moved there and a refresh adds a row', async () => {
    const { onEject, rerender, element } = await openAt(['ArrowDown', 'ArrowDown', 'ArrowDown'])
    const extra = { key: 'unsloth/Qwen3-1B-GGUF/Q4_K_M.gguf', name: 'Qwen3 1B', quant: 'Q4_K_M', incomplete: false, parseError: null, loaded: false }
    rerender(element({ models: [...LOCAL, extra as unknown as ModelEntry] }))
    expect(activeRows()).toEqual([screen.getByText('Eject model')])
    await userEvent.keyboard('{Enter}')
    expect(onEject).toHaveBeenCalledTimes(1)
  })

  it('keeps the same row highlighted when a refresh inserts a model before it', async () => {
    const { onLoad, rerender, element } = await openAt(['ArrowDown'])
    const inserted = { key: 'acme/Qwen3-0.5B-GGUF/Q4_K_M.gguf', name: 'Qwen3 0.5B', quant: 'Q4_K_M', incomplete: false, parseError: null, loaded: false }
    rerender(element({ models: [inserted as unknown as ModelEntry, ...LOCAL] }))
    expect(activeRows()).toEqual([rowOf('Qwen3 8B')])
    await userEvent.keyboard('{Enter}')
    expect(onLoad).toHaveBeenCalledWith(QWEN8)
  })
})

describe('one highlight for mouse and keyboard', () => {
  it('moves the highlight to a hovered row, and Enter loads it', async () => {
    const { onLoad } = await openMenu()
    await userEvent.keyboard('qwen')
    await userEvent.hover(rowOf('Qwen3 8B'))
    expect(activeRows()).toEqual([rowOf('Qwen3 8B')])
    await userEvent.keyboard('{Enter}')
    expect(onLoad).toHaveBeenCalledWith(QWEN8)
  })

  it('continues arrowing from the hovered row', async () => {
    await openMenu()
    await userEvent.hover(rowOf('Gemma 27B'))
    await userEvent.keyboard('{ArrowDown}')
    expect(activeRows()).toEqual([rowOf('Qwen3 35B')])
  })

  it('highlights Eject on hover while focus stays in the box', async () => {
    await openMenu({ loadedKey: GEMMA, loadedName: 'Gemma 27B' })
    await userEvent.hover(screen.getByText('Eject model'))
    expect(activeRows()).toEqual([screen.getByText('Eject model')])
    expect(searchBox()).toHaveFocus()
  })
})
