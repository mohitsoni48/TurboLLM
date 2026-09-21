// The Workspace's only surface while a Jev model is loaded (ADR-434 (b), (c), (i)(1)).
//
// The two drafts are the thing to hold onto: a Jev model answers two different questions, and
// swapping between them must not throw away what the user typed in the other one.
import { render, screen, waitFor, within, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { JevPlaygroundScreen } from './JevPlaygroundScreen'
import { JEV_EXAMPLES } from './jev-examples'
import { ApiError } from '../../lib/api'
import type { ClassifyResponse, ModelEntry, RerankResponse, Status } from '../../lib/types'

const h = vi.hoisted(() => ({
  classify: vi.fn(),
  rerank: vi.fn(),
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
  classify: (...a: unknown[]) => h.classify(...a),
  rerank: (...a: unknown[]) => h.rerank(...a),
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

const JEV_INFO = {
  labels: ['contradiction', 'entailment', 'neutral'] as const,
  nliTemplate: 'Premise: {premise}\nHypothesis: {hypothesis}',
  architecture: 'Qwen3_5ForSequenceClassification',
  verified: true,
}

const CLASSIFY_REPLY: ClassifyResponse = {
  model: KEY,
  results: [
    { hypothesis: 'Someone is preparing food.', label: 'entailment', probs: { contradiction: 0, entailment: 0.957, neutral: 0.043 } },
  ],
  usage: { prompt_tokens: 69, total_tokens: 69 },
}

const RERANK_REPLY: RerankResponse = {
  model: KEY,
  results: [{ index: 1, document: { text: 'Paris' }, relevance_score: 0.941, label: 'entailment' }],
  usage: { prompt_tokens: 51, total_tokens: 51 },
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

beforeEach(() => {
  for (const spy of Object.values(h)) spy.mockReset()
  h.classify.mockResolvedValue(CLASSIFY_REPLY)
  h.rerank.mockResolvedValue(RERANK_REPLY)
  state.status = status()
  state.models = [jevModel()]
})

describe('JevPlaygroundScreen', () => {
  it('opens on the kitchen example and answers it straight away', async () => {
    renderScreen()
    expect(screen.getByLabelText('Premise')).toHaveValue('A chef is chopping onions in a busy restaurant kitchen.')
    await waitFor(() => expect(h.classify).toHaveBeenCalledTimes(1))
    expect(h.classify).toHaveBeenCalledWith({
      model: KEY,
      premise: 'A chef is chopping onions in a busy restaurant kitchen.',
      hypotheses: ['Someone is preparing food.', 'The kitchen is empty and silent.', 'The chef is wearing a blue apron.'],
    })
    expect(await screen.findByText('0.957')).toBeTruthy()
  })

  it('waits for the engine before asking it anything', async () => {
    state.status = status({ jev: { key: KEY, name: 'qwen3.5 4b nli v2', labels: ['contradiction', 'entailment', 'neutral'], state: 'starting', slot: 'primary' } })
    renderScreen()
    expect(screen.getByText(/Loading…/)).toBeTruthy()
    await Promise.resolve()
    expect(h.classify).not.toHaveBeenCalled()
  })

  it('runs again on Ctrl+Enter from anywhere on the page', async () => {
    renderScreen()
    await waitFor(() => expect(h.classify).toHaveBeenCalledTimes(1))
    fireEvent.keyDown(window, { key: 'Enter', ctrlKey: true })
    await waitFor(() => expect(h.classify).toHaveBeenCalledTimes(2))
  })

  // ADR-434 (c), QA E5: Results / JSON / API are three views of ONE run. A second run started
  // over the first, or an older answer landing last, breaks that.
  describe('one run at a time', () => {
    /** A run that stays in flight until the test resolves it. */
    function slowClassify() {
      let answer: (() => void) | undefined
      h.classify.mockImplementation(() => new Promise<ClassifyResponse>((resolve) => {
        answer = () => resolve(CLASSIFY_REPLY)
      }))
      return () => answer?.()
    }

    it('ignores Ctrl+Enter while a run is still in flight', async () => {
      const answer = slowClassify()
      renderScreen()
      await waitFor(() => expect(h.classify).toHaveBeenCalledTimes(1))

      fireEvent.keyDown(window, { key: 'Enter', ctrlKey: true })
      fireEvent.keyDown(window, { key: 'Enter', ctrlKey: true })

      expect(h.classify).toHaveBeenCalledTimes(1)
      answer()
      await waitFor(() => expect(screen.getByText('0.957')).toBeTruthy())
    })

    it('will not let an example be picked mid-run', async () => {
      slowClassify()
      renderScreen()
      await waitFor(() => expect(h.classify).toHaveBeenCalledTimes(1))

      expect(screen.getByRole('combobox')).toBeDisabled()
    })

    // The message under the panel belongs to a run that was really refused. A run that was
    // ignored because another one is still in flight has nothing to say about the draft.
    it('says nothing about the draft when it is the run in flight that stopped it', async () => {
      renderScreen()
      await waitFor(() => expect(h.classify).toHaveBeenCalledTimes(1))
      await userEvent.click(screen.getByRole('button', { name: 'Choose' }))
      await userEvent.clear(screen.getByLabelText('Question'))
      await userEvent.click(screen.getByRole('button', { name: 'Check' }))

      const answer = slowClassify()
      await userEvent.click(screen.getByRole('button', { name: 'Run' }))
      await waitFor(() => expect(h.classify).toHaveBeenCalledTimes(2))
      await userEvent.click(screen.getByRole('button', { name: 'Choose' }))
      fireEvent.keyDown(window, { key: 'Enter', ctrlKey: true })

      expect(screen.queryByText('Enter a question first')).toBeNull()
      expect(h.rerank).not.toHaveBeenCalled()
      answer()
    })

    // The picker is disabled while a run is in flight, but the first run starts from an effect
    // that lands after the paint that would disable it. Picking in that frame must not throw
    // away the run on screen to start one it cannot start.
    it('keeps the run it cannot replace when an example is picked mid-run', async () => {
      const answer = slowClassify()
      renderScreen()
      await waitFor(() => expect(h.classify).toHaveBeenCalledTimes(1))

      fireEvent.change(screen.getByRole('combobox'), { target: { value: JEV_EXAMPLES.choose[0].id } })
      answer()

      expect(await screen.findByText('0.957')).toBeTruthy()
      expect(h.rerank).not.toHaveBeenCalled()
      expect(screen.getByLabelText('Premise')).toHaveValue('A chef is chopping onions in a busy restaurant kitchen.')
    })

    // The reviewer's own path (picking a Choose example mid-run) is unreachable now that the
    // picker is disabled; the Mode toggle reaches the same mechanism and is not disabled.
    it('drops an answer the user has already moved on from', async () => {
      const answer = slowClassify()
      renderScreen()
      await waitFor(() => expect(h.classify).toHaveBeenCalledTimes(1))

      await userEvent.click(screen.getByRole('button', { name: 'Choose' }))
      answer()

      await waitFor(() => expect(screen.getByRole('combobox')).not.toBeDisabled())
      expect(screen.queryByText('0.957')).toBeNull()
      expect(screen.getByText('Run to see results.')).toBeTruthy()
    })
  })

  it('says what is missing instead of sending an empty check', async () => {
    renderScreen()
    await waitFor(() => expect(h.classify).toHaveBeenCalledTimes(1))
    await userEvent.clear(screen.getByLabelText('Premise'))
    await userEvent.click(screen.getByRole('button', { name: 'Run' }))
    expect(screen.getByText('Enter a premise first')).toBeTruthy()
    expect(h.classify).toHaveBeenCalledTimes(1)
  })

  it('says what is missing instead of sending an empty choose', async () => {
    renderScreen()
    await userEvent.click(screen.getByRole('button', { name: 'Choose' }))
    await userEvent.clear(screen.getByLabelText('Question'))
    await userEvent.click(screen.getByRole('button', { name: 'Run' }))
    expect(screen.getByText('Enter a question first')).toBeTruthy()
    expect(h.rerank).not.toHaveBeenCalled()
  })

  it('keeps both drafts across a mode switch, and asks nothing while switching', async () => {
    renderScreen()
    await waitFor(() => expect(h.classify).toHaveBeenCalledTimes(1))
    await userEvent.type(screen.getByLabelText('Premise'), '!')

    await userEvent.click(screen.getByRole('button', { name: 'Choose' }))
    expect(screen.getByLabelText('Question')).toHaveValue('What is the capital of France?')
    await userEvent.click(screen.getByRole('button', { name: 'Check' }))

    expect(screen.getByLabelText('Premise')).toHaveValue('A chef is chopping onions in a busy restaurant kitchen.!')
    expect(h.classify).toHaveBeenCalledTimes(1)
    expect(h.rerank).not.toHaveBeenCalled()
    expect(h.track).toHaveBeenCalledWith('workspace', 'jev_mode_choose')
    expect(h.track).toHaveBeenCalledWith('workspace', 'jev_mode_check')
  })

  it('forgets the last answer when the question changes kind', async () => {
    renderScreen()
    expect(await screen.findByText('0.957')).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: 'Choose' }))
    expect(screen.queryByText('0.957')).toBeNull()
    expect(screen.getByText('Run to see results.')).toBeTruthy()
  })

  it('shows which example is loaded, offering only the four', () => {
    renderScreen()
    const picker = screen.getByRole('combobox')
    expect(picker).toHaveValue('kitchen')
    expect(within(picker).getAllByRole('option').map((o) => o.textContent)).toEqual([
      'Example: kitchen (check)',
      'Example: stage (check)',
      'Example: capital (choose)',
      'Example: plants (choose)',
    ])
  })

  it('loads a chosen example into its own mode and runs it', async () => {
    renderScreen()
    await waitFor(() => expect(h.classify).toHaveBeenCalledTimes(1))
    await userEvent.selectOptions(screen.getByRole('combobox'), 'capital')
    await waitFor(() => expect(h.rerank).toHaveBeenCalledTimes(1))
    expect(h.rerank).toHaveBeenCalledWith({
      model: KEY,
      query: 'What is the capital of France?',
      documents: ['Berlin', 'Paris', 'Madrid'],
    })
    expect(screen.getByLabelText('Question')).toBeTruthy()
    expect(h.track).toHaveBeenCalledWith('workspace', 'jev_load_example')
  })

  it('explains why Chat, Code and Routines are gone — but only when it redirected the user', async () => {
    const { unmount } = renderScreen(true)
    expect(screen.getByText('Chat, Code and Routines are unavailable while a Jev model is loaded.')).toBeTruthy()
    unmount()
    renderScreen()
    expect(screen.queryByText('Chat, Code and Routines are unavailable while a Jev model is loaded.')).toBeNull()
  })

  it('shows the Workspace column with the playground as its only item', () => {
    renderScreen()
    expect(screen.getByText('Workspace')).toBeTruthy()
    expect(screen.getByText('Jev Playground')).toBeTruthy()
    expect(screen.getByText('Chat, Code and Routines are hidden while a Jev model is loaded.')).toBeTruthy()
  })

  it("quotes the model's own template, with the slots filled in", () => {
    renderScreen()
    // Identity normalizer: the default one collapses whitespace, which would let a template
    // still carrying its raw newline pass as though it had been flattened to one line.
    expect(
      screen.getByText(`Sent as the model's own template: "Premise: … Hypothesis: …"`, { normalizer: (s) => s }),
    ).toBeTruthy()
  })

  it('says nothing about a template the model does not have', () => {
    state.models = [jevModel({ jev: { ...JEV_INFO, labels: [...JEV_INFO.labels], nliTemplate: null } })]
    renderScreen()
    expect(screen.queryByText(/Sent as the model/)).toBeNull()
  })

  it('explains what a Choose run does to each option', async () => {
    renderScreen()
    await userEvent.click(screen.getByRole('button', { name: 'Choose' }))
    expect(screen.getByText('Each option is checked as "The correct answer is: …" and ranked by entailment.')).toBeTruthy()
  })

  it('shows the raw response and the matching command', async () => {
    const { container } = renderScreen()
    await waitFor(() => expect(h.classify).toHaveBeenCalledTimes(1))

    await userEvent.click(screen.getByRole('button', { name: 'JSON' }))
    expect(container.querySelector('pre')?.textContent).toBe(JSON.stringify(CLASSIFY_REPLY, null, 2))

    await userEvent.click(screen.getByRole('button', { name: 'API' }))
    expect(container.querySelector('pre')?.textContent).toContain(`curl ${window.location.origin}/v1/classify`)
  })

  it("relays the daemon's own refusal", async () => {
    h.classify.mockRejectedValue(new ApiError('jev_template_missing', 'This model declares no nli_template.', 400))
    renderScreen()
    expect(await screen.findByText('This model declares no nli_template.')).toBeTruthy()
  })

  it('falls back to the models list when the status carries no Jev block', async () => {
    state.status = status({ jev: undefined })
    renderScreen()
    expect(screen.getByText('qwen3.5 4b nli v2 · vLLM 0.29 · running')).toBeTruthy()
    await waitFor(() => expect(h.classify).toHaveBeenCalledTimes(1))
  })

  it('still works for a scoped token that cannot read the status at all', async () => {
    state.status = undefined
    renderScreen()
    expect(screen.getByText('qwen3.5 4b nli v2 · running')).toBeTruthy()
    await waitFor(() => expect(h.classify).toHaveBeenCalledTimes(1))
  })

  it('renders nothing at all when no Jev model can be found', () => {
    state.status = status({ jev: null })
    state.models = []
    const { container } = renderScreen()
    expect(container.textContent).toBe('')
  })

  it('switches away through the menu, ejecting the pool slot first', async () => {
    const chat = { key: 'gemma-27b', name: 'Gemma 27B', loaded: false, incomplete: false, parseError: null, embedding: false, compatibleWithActiveEngine: true } as ModelEntry
    state.status = status({ jev: { key: KEY, name: 'qwen3.5 4b nli v2', labels: ['contradiction', 'entailment', 'neutral'], state: 'running', slot: 'pool' } })
    state.models = [jevModel(), chat]
    renderScreen()

    await userEvent.click(screen.getByRole('button', { name: 'Switch model' }))
    await userEvent.click(within(screen.getByRole('group', { name: 'Chat models' })).getByRole('button'))

    await waitFor(() => expect(h.requestLoad).toHaveBeenCalledWith(chat))
    expect(h.stopEngine).toHaveBeenCalledWith(KEY)
    expect(h.track).toHaveBeenCalledWith('workspace', 'jev_switch_model')
  })

  // N3: read off the models list, the slot is unknowable — claiming `primary` silently skipped
  // the ADR-427 (c) eject for a Jev model that really was in a pool slot.
  it('does not claim a slot the models list cannot know', async () => {
    const chat = { key: 'gemma-27b', name: 'Gemma 27B', loaded: false, incomplete: false, parseError: null, embedding: false, compatibleWithActiveEngine: true } as ModelEntry
    state.status = status({ jev: undefined })
    state.models = [jevModel(), chat]
    renderScreen()

    await userEvent.click(screen.getByRole('button', { name: 'Switch model' }))
    await userEvent.click(within(screen.getByRole('group', { name: 'Chat models' })).getByRole('button'))

    await waitFor(() => expect(h.stopEngine).toHaveBeenCalledWith(KEY))
  })
})
