// The Workspace's only surface while a Jev model is loaded (ADR-434 (b), (c), (i)(1), ADR-439):
// the System One request as two JSON editors, with the answers beside them.
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { JevPlaygroundScreen } from './JevPlaygroundScreen'
import { draftRequest } from './systemone-draft'
import { SYSTEMONE_EXAMPLES } from './systemone-examples'
import { ApiError } from '../../lib/api'
import type { ModelEntry, Status } from '../../lib/types'
import type { SystemOneResponse } from '../../lib/systemone-types'

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

const RESPONSE: SystemOneResponse = {
  model: KEY,
  answers: {
    urgent: { type: 'noul', noul: 0.945 },
    team: {
      type: 'choice',
      choice: 'technical',
      probabilities: { billing: 0.3128654970760234, technical: 0.5019493177387915, sales: 0.18031189083820662, documentation: 0.004873294346978557 },
      confidence: 0.31205475103149055,
    },
    mood: {
      type: 'score',
      score: 2.013,
      legend: { 0: 'Calm, just asking or stating facts', 1: 'Mildly annoyed but polite', 2: 'Clearly frustrated', 3: 'Very angry, strong language' },
      probabilities: { 0: 0.086, 1: 0.089, 2: 0.551, 3: 0.274 },
      confidence: 0.49210868531804325,
    },
  },
  usage: { input_tokens: 129, output_tokens: 1 },
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

function runButton(): HTMLElement {
  return screen.getByRole('button', { name: 'Run' })
}

function picker(): HTMLElement {
  return screen.getByLabelText('Example')
}

function exampleNamed(id: string) {
  const example = SYSTEMONE_EXAMPLES.find((candidate) => candidate.id === id)
  if (example === undefined) throw new Error(`There is no example named ${id}.`)
  return example
}

function pressRunShortcut(modifier: 'ctrlKey' | 'metaKey' = 'ctrlKey'): boolean {
  return fireEvent.keyDown(window, { key: 'Enter', [modifier]: true })
}

/** The request a run of this example must post: the same object the curl view renders. */
function requestOf(example = FIRST_EXAMPLE) {
  const drafted = draftRequest(KEY, example)
  if (!drafted.ok) throw new Error('The example is not a valid draft.')
  return drafted.request
}

/** A run that stays in flight until the test settles it. */
function slowRun(): () => Promise<void> {
  let settle: () => void = () => {}
  h.systemone.mockImplementation(
    () => new Promise<SystemOneResponse>((resolve) => { settle = () => resolve(RESPONSE) }),
  )
  return () => act(async () => { settle() })
}

/** Lets every timer and promise that is already due run, so "nothing was sent" is a settled claim. */
const tick = () => act(async () => { await new Promise<void>((resolve) => setTimeout(resolve, 0)) })

beforeEach(() => {
  for (const spy of Object.values(h)) spy.mockReset()
  h.systemone.mockResolvedValue(RESPONSE)
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

describe('JevPlaygroundScreen running the request', () => {
  it('posts exactly the request the editors describe when Run is clicked', async () => {
    renderScreen()
    await userEvent.click(runButton())
    await waitFor(() => expect(h.systemone).toHaveBeenCalledTimes(1))
    expect(h.systemone).toHaveBeenCalledWith(requestOf())
    expect(Object.keys(h.systemone.mock.calls[0][0])).toEqual(['state', 'model', 'questions'])
    expect(h.systemone.mock.calls[0][0].model).toBe(KEY)
  })

  it('shows the answers, the raw response and the request as curl after a run', async () => {
    const { container } = renderScreen()
    await userEvent.click(runButton())

    expect(await screen.findByText('0.945')).toBeInTheDocument()
    expect(container.querySelector('pre')?.textContent).toContain('"input_tokens": 129')
    expect(screen.getByText(/^\d+ ms · 129 input tokens$/)).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'curl' }))
    const command = container.querySelector('pre')?.textContent
    expect(command).toMatch(new RegExp(`^curl ${window.location.origin}/v1/systemone`))
    expect(command).toContain(JSON.stringify(requestOf()).replaceAll("'", "'\\''"))
  })

  it('keeps showing the request that ran, not the draft as it is edited afterwards', async () => {
    const { container } = renderScreen()
    await userEvent.click(runButton())
    await screen.findByText('0.945')

    editText('state', 'A different message, typed after the run.')
    await userEvent.click(screen.getByRole('button', { name: 'curl' }))

    expect(container.querySelector('pre')?.textContent).not.toContain('A different message')
    expect(container.querySelector('pre')?.textContent).toContain('Payment provider integration failing')
  })

  it('runs on Ctrl+Enter and on Meta+Enter from anywhere on the page', async () => {
    renderScreen()
    expect(pressRunShortcut('ctrlKey')).toBe(false)
    await waitFor(() => expect(h.systemone).toHaveBeenCalledTimes(1))
    await screen.findByText('0.945')

    expect(pressRunShortcut('metaKey')).toBe(false)
    await waitFor(() => expect(h.systemone).toHaveBeenCalledTimes(2))
  })

  it('ignores a second run while one is in flight', async () => {
    const settle = slowRun()
    renderScreen()
    const run = runButton()
    await userEvent.click(run)
    await waitFor(() => expect(h.systemone).toHaveBeenCalledTimes(1))

    pressRunShortcut()
    pressRunShortcut('metaKey')
    await userEvent.click(run)

    expect(h.systemone).toHaveBeenCalledTimes(1)
    await settle()
    expect(await screen.findByText('0.945')).toBeInTheDocument()
  })

  it('reads Running… and dims the previous answers while a run is in flight', async () => {
    renderScreen()
    const run = runButton()
    await userEvent.click(run)
    await screen.findByText('0.945')

    const settle = slowRun()
    await userEvent.click(run)
    await waitFor(() => expect(h.systemone).toHaveBeenCalledTimes(2))

    expect(run).toHaveTextContent('Running…')
    expect(run).toBeDisabled()
    expect(screen.getByText('0.945').closest('[aria-busy]')).toHaveAttribute('aria-busy', 'true')
    await settle()
  })

  it('will not send a draft the questions editor shows as invalid', async () => {
    renderScreen()
    editText('questions', '{oops')
    const run = runButton()
    expect(run).toBeDisabled()

    await userEvent.click(run)
    pressRunShortcut()

    expect(h.systemone).not.toHaveBeenCalled()
  })

  it('will not send a request that is too large, and says why', async () => {
    renderScreen()
    editText('state', 'a'.repeat(1_048_577))
    const run = runButton()

    expect(run).toBeDisabled()
    expect(screen.getByText('body must be at most 1048576 characters.')).toBeInTheDocument()
    await userEvent.click(run)
    pressRunShortcut()
    expect(h.systemone).not.toHaveBeenCalled()
  })

  it('shows the server refusal above the answers, keeps the previous answers, and clears it on the next run', async () => {
    renderScreen()
    const run = runButton()
    await userEvent.click(run)
    await screen.findByText('0.945')

    const refusal = 'state is too long: this model reads about 8,192 tokens for the state and one question together.'
    h.systemone.mockRejectedValueOnce(new ApiError('invalid_request', refusal, 422))
    await userEvent.click(run)

    expect(await screen.findByRole('alert')).toHaveTextContent(refusal)
    expect(screen.getByText('0.945')).toBeInTheDocument()

    await userEvent.click(run)
    await waitFor(() => expect(h.systemone).toHaveBeenCalledTimes(3))
    await waitFor(() => expect(run).toBeEnabled())
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it.each([
    ['an Error', new Error('boom'), 'boom'],
    ['something that is not an Error', 'nope', 'The request failed.'],
  ])('shows a failure that is %s as one readable line', async (_kind, rejection, shown) => {
    h.systemone.mockRejectedValue(rejection)
    renderScreen()
    await userEvent.click(runButton())

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toBe(shown)
  })

  it.each(['starting', 'stopping'] as const)('does not send while the model is %s', async (modelState) => {
    state.status = status({
      jev: { key: KEY, name: 'qwen3.5 4b nli v2', labels: ['contradiction', 'entailment', 'neutral'], state: modelState, slot: 'primary' },
    })
    renderScreen()

    expect(runButton()).toBeDisabled()
    pressRunShortcut()
    pressRunShortcut('metaKey')
    await tick()
    expect(h.systemone).not.toHaveBeenCalled()
  })

  it('sends nothing until asked, and records no telemetry for a run', async () => {
    renderScreen()
    await tick()
    await tick()
    expect(h.systemone).not.toHaveBeenCalled()

    await userEvent.click(runButton())
    await screen.findByText('0.945')

    const actions: string[] = h.track.mock.calls.map(([, action]) => String(action))
    expect(actions.filter((action) => action.startsWith('jev_run'))).toEqual([])
  })

  it('names the Run button Run, declares its shortcuts, and keeps the hint outside it', () => {
    renderScreen()
    const run = screen.getByRole('button', { name: 'Run' })
    const hint = screen.getByText('⌘/Ctrl+Enter')

    expect(run).toHaveAttribute('aria-keyshortcuts', 'Meta+Enter Control+Enter')
    expect(run).not.toContainElement(hint)
    expect(hint.tagName).toBe('SPAN')
  })

  it('has no Cancel button, idle or mid-run', async () => {
    slowRun()
    renderScreen()
    expect(screen.queryByRole('button', { name: /cancel/i })).toBeNull()

    await userEvent.click(runButton())
    await waitFor(() => expect(h.systemone).toHaveBeenCalledTimes(1))
    expect(screen.queryByRole('button', { name: /cancel/i })).toBeNull()
  })
})

describe('JevPlaygroundScreen picking an example', () => {
  it('offers the four examples by their labels', () => {
    renderScreen()
    const labels = within(picker()).getAllByRole('option').map((option) => option.textContent)
    expect(labels).toEqual(SYSTEMONE_EXAMPLES.map((example) => example.label))
  })

  it('loads the picked example into both editors without running it', async () => {
    renderScreen()
    await userEvent.selectOptions(picker(), 'routing')

    const routing = exampleNamed('routing')
    expect(screen.getByLabelText('state')).toHaveValue(routing.stateText)
    expect(screen.getByLabelText('questions')).toHaveValue(routing.questionsText)
    expect(picker()).toHaveValue('routing')
    expect(h.systemone).not.toHaveBeenCalled()
    expect(h.track).toHaveBeenCalledWith('workspace', 'jev_load_example')
  })

  it('replaces what the user had typed', async () => {
    renderScreen()
    editText('state', 'Typed by hand.')
    editText('questions', '{"typed":"by hand"}')

    await userEvent.selectOptions(picker(), 'yes-no')

    expect(screen.getByLabelText('state')).toHaveValue(exampleNamed('yes-no').stateText)
    expect(screen.getByLabelText('questions')).toHaveValue(exampleNamed('yes-no').questionsText)
  })

  it('clears the answers of a previous run', async () => {
    renderScreen()
    await userEvent.click(runButton())
    await screen.findByText('0.945')

    await userEvent.selectOptions(picker(), 'yes-no')

    expect(screen.queryByText('0.945')).toBeNull()
    expect(screen.getByText('Run, or press ⌘/Ctrl+Enter.')).toBeInTheDocument()
    expect(screen.getByText('Run to see the response and the request as curl.')).toBeInTheDocument()
  })

  it('clears the failure line of a previous run', async () => {
    h.systemone.mockRejectedValue(new Error('boom'))
    renderScreen()
    await userEvent.click(runButton())
    expect(await screen.findByRole('alert')).toHaveTextContent('boom')

    await userEvent.selectOptions(picker(), 'yes-no')

    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('leaves the picker usable while a run is in flight', async () => {
    const settle = slowRun()
    renderScreen()
    await userEvent.click(runButton())
    await waitFor(() => expect(h.systemone).toHaveBeenCalledTimes(1))

    expect(picker()).not.toBeDisabled()
    await settle()
  })

  it('drops the answer of a run the user has moved on from, and posts the picked example next', async () => {
    const settle = slowRun()
    renderScreen()
    const run = runButton()
    await userEvent.click(run)
    await waitFor(() => expect(h.systemone).toHaveBeenCalledTimes(1))

    await userEvent.selectOptions(picker(), 'routing')
    expect(run).toBeDisabled()

    await settle()
    expect(screen.queryByText('0.945')).toBeNull()
    expect(screen.getByText('Run, or press ⌘/Ctrl+Enter.')).toBeInTheDocument()
    await waitFor(() => expect(run).toBeEnabled())

    h.systemone.mockResolvedValue(RESPONSE)
    await userEvent.click(run)
    await waitFor(() => expect(h.systemone).toHaveBeenCalledTimes(2))
    expect(h.systemone).toHaveBeenLastCalledWith(requestOf(exampleNamed('routing')))
  })

  it('drops the failure of a run the user has moved on from', async () => {
    let refuse: (reason: Error) => void = () => {}
    h.systemone.mockImplementation(() => new Promise((_resolve, reject) => { refuse = reject }))
    renderScreen()
    await userEvent.click(runButton())
    await waitFor(() => expect(h.systemone).toHaveBeenCalledTimes(1))

    await userEvent.selectOptions(picker(), 'routing')
    await act(async () => { refuse(new Error('too late')) })

    expect(screen.queryByRole('alert')).toBeNull()
  })
})
