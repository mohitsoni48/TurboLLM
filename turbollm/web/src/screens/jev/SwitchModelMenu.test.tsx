// The way back out of the playground (ADR-434 (i)(5)). Picking a chat model from a POOL slot
// has to eject that slot first (ADR-427) — otherwise the Jev engine keeps the slot and the
// gateway can still route to it, so Workspace would never go back to Chat.
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SwitchModelMenu, ejectModel, switchToModel } from './SwitchModelMenu'
import type { JevStatus, ModelEntry } from '../../lib/types'

const h = vi.hoisted(() => ({ track: vi.fn(), toastError: vi.fn() }))

vi.mock('../../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/api')>()
  return { ...actual, track: (...a: unknown[]) => h.track(...a) }
})

vi.mock('../../components/ui/sonner', () => ({
  toast: { error: (...a: unknown[]) => h.toastError(...a), success: vi.fn() },
}))

const CURRENT: JevStatus = {
  key: 'jev-loaded',
  name: 'qwen3.5 4b nli v2',
  labels: ['contradiction', 'entailment', 'neutral'],
  state: 'running',
  slot: 'primary',
}

const JEV_INFO = {
  labels: ['contradiction', 'entailment', 'neutral'] as const,
  nliTemplate: 'Premise: {premise}\nHypothesis: {hypothesis}',
  architecture: 'Qwen3_5ForSequenceClassification',
  verified: true,
}

function model(over: Partial<ModelEntry> & { key: string; name: string }): ModelEntry {
  return {
    incomplete: false,
    parseError: null,
    embedding: false,
    compatibleWithActiveEngine: true,
    loaded: false,
    ...over,
  } as ModelEntry
}

const CHAT = model({ key: 'gemma-27b', name: 'Gemma 27B' })
const OTHER_JEV = model({ key: 'jev-other', name: 'Other NLI', jev: { ...JEV_INFO, labels: [...JEV_INFO.labels] } })
const LAYA = model({ key: 'laya', name: 'Laya', laya: { checkpoints: ['english', 'multilingual'] } })

/** The row a model's button sits in: the button and, for a text classification model, its runtime label. */
function rowOf(name: string): HTMLElement {
  const row = screen.getByRole('button', { name }).parentElement
  if (row === null) throw new Error(`The ${name} button is not in a row.`)
  return row
}

function renderMenu(models: ModelEntry[], current: JevStatus = CURRENT, showAllEngineModels?: boolean) {
  const onPick = vi.fn()
  render(<SwitchModelMenu current={current} models={models} onPick={onPick} showAllEngineModels={showAllEngineModels} />)
  return { onPick }
}

beforeEach(() => {
  h.track.mockReset()
  h.toastError.mockReset()
})

describe('SwitchModelMenu', () => {
  it('groups what can be loaded by what it is', () => {
    renderMenu([CHAT, OTHER_JEV])
    expect(screen.getByText('Chat models')).toBeTruthy()
    expect(screen.getByText('Text classification models')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Gemma 27B' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Other NLI' })).toBeTruthy()
  })

  it('leaves out a group with nothing in it', () => {
    renderMenu([CHAT])
    expect(screen.getByText('Chat models')).toBeTruthy()
    expect(screen.queryByText('Text classification models')).toBeNull()
  })

  // POST /v1/systemone answers with either a Jev or a Laya model (ADR-439 follow-up), and ADR-444 names both
  // "text classification": one group, each row saying which runtime serves it.
  it('puts Jev and Laya models in one text classification group', () => {
    renderMenu([CHAT, OTHER_JEV, LAYA])
    const group = screen.getByRole('group', { name: 'Text classification models' })
    expect(within(group).getByRole('button', { name: 'Other NLI' })).toBeTruthy()
    expect(within(group).getByRole('button', { name: 'Laya' })).toBeTruthy()
    expect(screen.queryByText('Jev models')).toBeNull()
    expect(screen.queryByText('Laya models')).toBeNull()
  })

  it('labels each text classification row with its runtime, and a chat row with none', () => {
    renderMenu([CHAT, OTHER_JEV, LAYA])
    expect(rowOf('Other NLI').textContent).toBe('Other NLIvLLM')
    expect(rowOf('Laya').textContent).toBe('LayaLaya engine')
    expect(rowOf('Gemma 27B').textContent).toBe('Gemma 27B')
  })

  it('offers only models that could actually load right now', () => {
    renderMenu([
      CHAT,
      model({ key: 'half', name: 'Half-downloaded', incomplete: true }),
      model({ key: 'broken', name: 'Unreadable', parseError: 'bad config.json' }),
      model({ key: 'gguf', name: 'Wrong format', compatibleWithActiveEngine: false }),
      model({ key: 'embed', name: 'An embedder', embedding: true }),
    ])
    const names = screen.getAllByRole('button').map((b) => b.textContent)
    expect(names).toEqual(['Gemma 27B'])
  })

  // Settings → Models, "Show models for every engine" covers this picker too: such a pick loads on the selected engine,
  // which shows its own error if it cannot. A Laya model never runs there, so with no Laya engine it is still not
  // offered.
  it('offers a model the engine cannot run with "Show models for every engine" on', () => {
    renderMenu([
      CHAT,
      model({ key: 'gguf', name: 'Wrong format', compatibleWithActiveEngine: false }),
      model({ key: 'laya-off', name: 'Laya, no engine', laya: { checkpoints: ['english'] }, compatibleWithActiveEngine: false }),
      model({ key: 'embed', name: 'An embedder', embedding: true }),
    ], CURRENT, true)
    const names = screen.getAllByRole('button').map((b) => b.textContent)
    expect(names).toEqual(['Gemma 27B', 'Wrong format'])
  })

  it('does not offer the model that is already loaded', () => {
    renderMenu([CHAT, model({ key: CURRENT.key, name: CURRENT.name, jev: { ...JEV_INFO, labels: [...JEV_INFO.labels] }, loaded: true })])
    expect(screen.queryByText('Text classification models')).toBeNull()
    expect(screen.queryByRole('button', { name: CURRENT.name })).toBeNull()
  })

  // Both groups can empty at once — a library of GGUF chat models plus one safetensors Jev
  // model under vLLM leaves nothing loadable — and an empty bordered box explains nothing.
  it('says where to go when nothing here can load', () => {
    renderMenu([model({ key: 'gguf', name: 'Wrong format', compatibleWithActiveEngine: false })])
    expect(screen.getByText('Nothing else here can load on the active engine. Change it on the Engines screen.')).toBeTruthy()
    expect(screen.queryByText('Chat models')).toBeNull()
    expect(screen.queryByText('Text classification models')).toBeNull()
  })

  it('says nothing of the sort once there is something to pick', () => {
    renderMenu([CHAT])
    expect(screen.queryByText(/Engines screen/)).toBeNull()
  })

  it('hands the picked model back whole', async () => {
    const { onPick } = renderMenu([CHAT, OTHER_JEV])
    await userEvent.click(within(screen.getByRole('group', { name: 'Chat models' })).getByRole('button'))
    expect(onPick).toHaveBeenCalledWith(CHAT)
  })
})

describe('switchToModel', () => {
  function deps() {
    const order: string[] = []
    return {
      order,
      stopEngine: vi.fn(async () => { order.push('stop') }),
      requestLoad: vi.fn(() => { order.push('load') }),
    }
  }

  it('ejects the Jev pool slot before loading a chat model', async () => {
    const d = deps()
    await switchToModel({ ...CURRENT, slot: 'pool' }, CHAT, d)
    expect(d.stopEngine).toHaveBeenCalledWith(CURRENT.key)
    expect(d.order).toEqual(['stop', 'load'])
    expect(d.requestLoad).toHaveBeenCalledWith(CHAT)
  })

  it('leaves the primary slot alone — loading replaces it anyway', async () => {
    const d = deps()
    await switchToModel(CURRENT, CHAT, d)
    expect(d.stopEngine).not.toHaveBeenCalled()
    expect(d.requestLoad).toHaveBeenCalledWith(CHAT)
  })

  it('keeps the pool slot when the next model is another Jev model', async () => {
    const d = deps()
    await switchToModel({ ...CURRENT, slot: 'pool' }, OTHER_JEV, d)
    expect(d.stopEngine).not.toHaveBeenCalled()
    expect(d.requestLoad).toHaveBeenCalledWith(OTHER_JEV)
  })

  // The models-list fallback cannot read the slot. Not ejecting a pool slot leaves the Jev engine
  // running, `status.jev` set, and Workspace stuck in the playground with nothing said — so an
  // unknown slot is ejected, and a stop that was not needed only costs a restart.
  it('ejects a slot it cannot name, rather than assuming it is the primary one', async () => {
    const d = deps()
    await switchToModel({ ...CURRENT, slot: null }, CHAT, d)
    expect(d.stopEngine).toHaveBeenCalledWith(CURRENT.key)
    expect(d.order).toEqual(['stop', 'load'])
  })

  // The v1.14.1 Opus review: a Laya load never replaces the primary, so a Jev model left loaded there keeps the
  // playground on the Jev model and the Laya "ready" toast (which reads status.jev first) never fires.
  it('ejects a Jev model in the primary slot before loading a Laya model, which never replaces the primary', async () => {
    const d = deps()
    await switchToModel(CURRENT, LAYA, d)
    expect(d.stopEngine).toHaveBeenCalledWith(CURRENT.key)
    expect(d.order).toEqual(['stop', 'load'])
    expect(d.requestLoad).toHaveBeenCalledWith(LAYA)
  })

  // A Laya model runs beside chat, so it would stay loaded behind the chat model. Switching model in the playground
  // replaces the playground's model; going back to chat is the playground's own step (JevPlaygroundScreen.test.tsx).
  it('ejects a loaded Laya model before loading the chat model picked', async () => {
    const d = deps()
    const layaCurrent = { key: 'laya', name: 'Laya', labels: [], checkpoints: ['english'], state: 'running' as const, slot: 'pool' as const }
    await switchToModel(layaCurrent, CHAT, d)
    expect(d.stopEngine).toHaveBeenCalledWith('laya')
    expect(d.order).toEqual(['stop', 'load'])
    expect(d.requestLoad).toHaveBeenCalledWith(CHAT)
  })

  it('ejects a loaded Laya model before loading another Laya model', async () => {
    const d = deps()
    const layaCurrent = { key: 'laya-old', name: 'Laya old', labels: [], checkpoints: ['english'], state: 'running' as const, slot: 'pool' as const }
    await switchToModel(layaCurrent, LAYA, d)
    expect(d.stopEngine).toHaveBeenCalledWith('laya-old')
    expect(d.order).toEqual(['stop', 'load'])
  })

  it('records the switch whichever model was picked', async () => {
    const d = deps()
    await switchToModel(CURRENT, CHAT, d)
    expect(h.track).toHaveBeenCalledWith('workspace', 'jev_switch_model')
  })

  // Never a silent no-op. A rejected eject is reported even though the panel has already
  // closed, so the pick cannot look like it did nothing.
  it('says why the switch stopped when the slot will not eject, and loads nothing on top of it', async () => {
    const { ApiError } = await import('../../lib/api')
    const d = deps()
    d.stopEngine.mockRejectedValue(new ApiError('engine_busy', 'The engine is still generating.', 409))

    await switchToModel({ ...CURRENT, slot: 'pool' }, CHAT, d)

    expect(h.toastError).toHaveBeenCalledWith('Could not switch model: The engine is still generating.')
    expect(d.requestLoad).not.toHaveBeenCalled()
  })

  it('points at the engine logs when the eject failed with no reason of its own', async () => {
    const d = deps()
    d.stopEngine.mockRejectedValue(new Error('network down'))

    await switchToModel({ ...CURRENT, slot: 'pool' }, CHAT, d)

    expect(h.toastError).toHaveBeenCalledWith('Could not switch model: check the engine logs on the Engines screen.')
  })

  // ADR-444, amended 2026-09-25: the playground stays open with nothing loaded, and its model list loads from there.
  it('loads straight away when the playground has nothing loaded', async () => {
    const d = deps()
    await switchToModel(null, OTHER_JEV, d)
    expect(d.stopEngine).not.toHaveBeenCalled()
    expect(d.requestLoad).toHaveBeenCalledWith(OTHER_JEV)
  })
})

describe('ejectModel', () => {
  it('stops the model\'s own slot and records the eject', async () => {
    const stopEngine = vi.fn(async () => ({}))
    await ejectModel(LAYA, { stopEngine })
    expect(stopEngine).toHaveBeenCalledWith('laya')
    expect(h.track).toHaveBeenCalledWith('workspace', 'eject_model')
  })

  it('says why when the model will not eject', async () => {
    const { ApiError } = await import('../../lib/api')
    const stopEngine = vi.fn(async () => { throw new ApiError('engine_busy', 'The engine is still generating.', 409) })
    await ejectModel(LAYA, { stopEngine })
    expect(h.toastError).toHaveBeenCalledWith('Could not eject model: The engine is still generating.')
  })
})
