// The way back out of the playground (ADR-434 (i)(5)). Picking a chat model from a POOL slot
// has to eject that slot first (ADR-427) — otherwise the Jev engine keeps the slot and the
// gateway can still route to it, so Workspace would never go back to Chat.
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SwitchModelMenu, switchToModel } from './SwitchModelMenu'
import type { JevStatus, ModelEntry } from '../../lib/types'

const h = vi.hoisted(() => ({ track: vi.fn() }))

vi.mock('../../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/api')>()
  return { ...actual, track: (...a: unknown[]) => h.track(...a) }
})

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

function renderMenu(models: ModelEntry[], current: JevStatus = CURRENT) {
  const onPick = vi.fn()
  render(<SwitchModelMenu current={current} models={models} onPick={onPick} />)
  return { onPick }
}

beforeEach(() => {
  h.track.mockReset()
})

describe('SwitchModelMenu', () => {
  it('groups what can be loaded by what it is', () => {
    renderMenu([CHAT, OTHER_JEV])
    expect(screen.getByText('Chat models')).toBeTruthy()
    expect(screen.getByText('Jev models')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Gemma 27B' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Other NLI' })).toBeTruthy()
  })

  it('leaves out a group with nothing in it', () => {
    renderMenu([CHAT])
    expect(screen.getByText('Chat models')).toBeTruthy()
    expect(screen.queryByText('Jev models')).toBeNull()
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

  it('does not offer the model that is already loaded', () => {
    renderMenu([CHAT, model({ key: CURRENT.key, name: CURRENT.name, jev: { ...JEV_INFO, labels: [...JEV_INFO.labels] }, loaded: true })])
    expect(screen.queryByText('Jev models')).toBeNull()
    expect(screen.queryByRole('button', { name: CURRENT.name })).toBeNull()
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
    expect(d.requestLoad).toHaveBeenCalledWith({ key: 'gemma-27b', name: 'Gemma 27B', isJev: false })
  })

  it('leaves the primary slot alone — loading replaces it anyway', async () => {
    const d = deps()
    await switchToModel(CURRENT, CHAT, d)
    expect(d.stopEngine).not.toHaveBeenCalled()
    expect(d.requestLoad).toHaveBeenCalledWith({ key: 'gemma-27b', name: 'Gemma 27B', isJev: false })
  })

  it('keeps the pool slot when the next model is another Jev model', async () => {
    const d = deps()
    await switchToModel({ ...CURRENT, slot: 'pool' }, OTHER_JEV, d)
    expect(d.stopEngine).not.toHaveBeenCalled()
    expect(d.requestLoad).toHaveBeenCalledWith({ key: 'jev-other', name: 'Other NLI', isJev: true })
  })

  it('records the switch whichever model was picked', async () => {
    const d = deps()
    await switchToModel(CURRENT, CHAT, d)
    expect(h.track).toHaveBeenCalledWith('workspace', 'jev_switch_model')
  })
})
