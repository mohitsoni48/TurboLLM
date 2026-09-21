// The Workspace's only surface while a Jev model is loaded (ADR-434 (b), (c), (i)(1), ADR-439):
// the System One request as two JSON editors, with the answers beside them.
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { JevPlaygroundScreen } from './JevPlaygroundScreen'
import { SYSTEMONE_EXAMPLES } from './systemone-examples'
import type { ModelEntry, Status } from '../../lib/types'

const h = vi.hoisted(() => ({
  systemone: vi.fn(),
  track: vi.fn(),
  stopEngine: vi.fn(),
  requestLoad: vi.fn(),
}))

const state: { status: Status | undefined; models: ModelEntry[] } = { status: undefined, models: [] }

vi.mock('../../lib/queries', () => ({
  useStatus: () => ({ data: state.status }),
  useModels: () => ({ data: { models: state.models, scanning: false } }),
}))
vi.mock('../../lib/jev-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/jev-api')>()),
  systemone: (...a: unknown[]) => h.systemone(...a),
}))
vi.mock('../../lib/model-loader', () => ({
  useModelLoader: () => ({ requestLoad: h.requestLoad, isPending: false, pendingKey: undefined }),
}))
vi.mock('../../lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/api')>()),
  track: (...a: unknown[]) => h.track(...a),
  stopEngine: (...a: unknown[]) => h.stopEngine(...a),
}))

const KEY = 'qwen3.5 4b nli v2|mlx-fp16|9012345678'

const FIRST_EXAMPLE = SYSTEMONE_EXAMPLES[0]

const JEV_INFO = {
  labels: ['contradiction', 'entailment', 'neutral'] as const,
  nliTemplate: 'Premise: {premise}\nHypothesis: {hypothesis}',
  architecture: 'Qwen3_5ForSequenceClassification',
  verified: true,
}

function status(over: Partial<Status> = {}): Status {
  return {
    engine: { id: 'vllm', name: 'vLLM 0.29', kind: 'vllm', state: 'running' },
    jev: { key: KEY, name: 'qwen3.5 4b nli v2', labels: ['contradiction', 'entailment', 'neutral'], state: 'running', slot: 'primary' },
    ...over,
  } as Status
}

function jevModel(over: Partial<ModelEntry> = {}): ModelEntry {
  return {
    key: KEY,
    name: 'qwen3.5 4b nli v2',
    loaded: true,
    incomplete: false,
    parseError: null,
    embedding: false,
    compatibleWithActiveEngine: true,
    jev: { ...JEV_INFO, labels: [...JEV_INFO.labels] },
    ...over,
  } as ModelEntry
}

function renderScreen(notice = false) {
  return render(
    <MemoryRouter initialEntries={[{ pathname: '/workspace/jev', state: notice ? { jevNotice: true } : undefined }]}>
      <JevPlaygroundScreen />
    </MemoryRouter>,
  )
}

function editText(label: string, text: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value: text } })
}

/** The editor's own root: its textarea, its status line and its problem line all sit inside it. */
function editorOf(label: string): HTMLElement {
  const root = screen.getByLabelText(label).parentElement
  if (root === null) throw new Error(`The ${label} editor is not attached to anything.`)
  return root
}

beforeEach(() => {
  for (const spy of Object.values(h)) spy.mockReset()
  state.status = status()
  state.models = [jevModel()]
})

describe('JevPlaygroundScreen', () => {
  it('opens on the first example, with the answers column waiting and nothing sent', () => {
    renderScreen()
    expect(screen.getByText('qwen3.5 4b nli v2 · vLLM 0.29 · running')).toBeInTheDocument()
    expect(screen.getByLabelText('state')).toHaveValue(FIRST_EXAMPLE.stateText)
    expect(screen.getByLabelText('questions')).toHaveValue(FIRST_EXAMPLE.questionsText)
    expect(screen.getByText('Run, or press ⌘/Ctrl+Enter.')).toBeInTheDocument()
    expect(
      screen.getByText("These are the model's NLI entailment scores, normalised — not a calibrated decision model."),
    ).toBeInTheDocument()
    expect(h.systemone).not.toHaveBeenCalled()
  })

  it('renders nothing at all when no Jev model can be found', () => {
    state.status = status({ jev: null })
    state.models = []
    const { container } = renderScreen()
    expect(container).toBeEmptyDOMElement()
  })

  it('still works for a scoped token that cannot read the status at all', () => {
    state.status = undefined
    renderScreen()
    expect(screen.getByText('qwen3.5 4b nli v2 · running')).toBeInTheDocument()
    expect(screen.getByLabelText('state')).toBeInTheDocument()
  })

  it('shows Loading… while the model is starting', () => {
    state.status = status({
      jev: { key: KEY, name: 'qwen3.5 4b nli v2', labels: ['contradiction', 'entailment', 'neutral'], state: 'starting', slot: 'primary' },
    })
    renderScreen()
    expect(screen.getByText(/Loading…/)).toBeInTheDocument()
  })

  it('explains why Chat, Code and Routines are gone, but only when it redirected the user', () => {
    const { unmount } = renderScreen(true)
    expect(screen.getByText('Chat, Code and Routines are unavailable while a Jev model is loaded.')).toBeInTheDocument()
    unmount()
    renderScreen()
    expect(screen.queryByText('Chat, Code and Routines are unavailable while a Jev model is loaded.')).toBeNull()
  })

  it('switches away through the menu, ejecting the pool slot first', async () => {
    const chat = { key: 'gemma-27b', name: 'Gemma 27B', loaded: false, incomplete: false, parseError: null, embedding: false, compatibleWithActiveEngine: true } as ModelEntry
    state.status = status({
      jev: { key: KEY, name: 'qwen3.5 4b nli v2', labels: ['contradiction', 'entailment', 'neutral'], state: 'running', slot: 'pool' },
    })
    state.models = [jevModel(), chat]
    renderScreen()

    await userEvent.click(screen.getByRole('button', { name: 'Switch model' }))
    await userEvent.click(within(screen.getByRole('group', { name: 'Chat models' })).getByRole('button'))

    await waitFor(() => expect(h.requestLoad).toHaveBeenCalledWith(chat))
    expect(h.stopEngine).toHaveBeenCalledWith(KEY)
    expect(h.track).toHaveBeenCalledWith('workspace', 'jev_switch_model')
  })

  it('has no mode toggle and no left rail', () => {
    renderScreen()
    expect(screen.queryByRole('button', { name: 'Check' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Choose' })).toBeNull()
    expect(screen.queryByText('Workspace')).toBeNull()
    expect(screen.queryByText('Jev Playground')).toBeNull()
  })

  it('captions the request with the endpoint and holds the response beside it', () => {
    renderScreen()
    expect(within(screen.getByRole('region', { name: 'Request' })).getByText('POST /v1/systemone')).toBeInTheDocument()
    expect(
      within(screen.getByRole('region', { name: 'Response' })).getByText('Run to see the response and the request as curl.'),
    ).toBeInTheDocument()
  })

  // jsdom cannot measure overflow; a real 375 px page is checked in the browser pass.
  it('lays the two sections out one column on a phone and two from md, letting both shrink', () => {
    renderScreen()
    const request = screen.getByRole('region', { name: 'Request' })
    const response = screen.getByRole('region', { name: 'Response' })
    expect(request.parentElement).toBe(response.parentElement)
    expect(request.parentElement).toHaveClass('grid', 'grid-cols-1', 'md:grid-cols-2')
    expect(request).toHaveClass('min-w-0')
    expect(response).toHaveClass('min-w-0')
  })

  it('shows unparseable questions text once, in the editor status line', () => {
    renderScreen()
    editText('questions', '{oops')
    expect(within(editorOf('questions')).getByText(/^Invalid JSON:/)).toBeInTheDocument()
    expect(screen.queryByText(/questions is not valid JSON/)).toBeNull()
  })

  it('shows a rule problem under the questions editor', () => {
    renderScreen()
    editText('questions', JSON.stringify({ urgent: { type: 'yesno', instructions: 'Does the message convey urgency?' } }))
    expect(
      within(editorOf('questions')).getByText('questions.urgent.type must be "noul", "choice" or "score".'),
    ).toBeInTheDocument()
    expect(within(editorOf('state')).queryByRole('alert')).toBeNull()
  })

  it('shows an empty state under the state editor', () => {
    renderScreen()
    editText('state', '')
    expect(within(editorOf('state')).getByText('state must not be empty.')).toBeInTheDocument()
    expect(within(editorOf('questions')).queryByRole('alert')).toBeNull()
  })

  it('shows both editors\' problems at once, each under its own editor', () => {
    renderScreen()
    editText('state', '')
    editText('questions', JSON.stringify({ urgent: { type: 'yesno', instructions: 'Does the message convey urgency?' } }))
    expect(within(editorOf('state')).getByText('state must not be empty.')).toBeInTheDocument()
    expect(
      within(editorOf('questions')).getByText('questions.urgent.type must be "noul", "choice" or "score".'),
    ).toBeInTheDocument()
  })

  it('still shows a problem that belongs to neither editor', () => {
    renderScreen()
    editText('state', 'a'.repeat(1_048_577))
    const problem = screen.getByText('body must be at most 1048576 characters.')
    expect(problem).toHaveAttribute('role', 'alert')
    expect(editorOf('state')).not.toContainElement(problem)
    expect(editorOf('questions')).not.toContainElement(problem)
  })

  it('survives a pasted draft nested far too deep', () => {
    renderScreen()
    expect(() => editText('state', '['.repeat(20000) + ']'.repeat(20000))).not.toThrow()
    expect(screen.getByLabelText('state')).toBeInTheDocument()
    expect(
      within(editorOf('state')).getByText('state must not be nested more than 32 levels deep.'),
    ).toBeInTheDocument()
  })
})
