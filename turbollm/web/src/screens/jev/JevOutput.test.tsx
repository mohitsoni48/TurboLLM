// The three ways to read one run (ADR-434 (c)): the rendered answer, the raw response, and the
// exact request as a command you can paste. Switching view never re-runs anything.
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { JevOutput } from './JevOutput'
import type { JevRun } from './jev-run'

const h = vi.hoisted(() => ({ track: vi.fn(), writeText: vi.fn() }))

vi.mock('../../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/api')>()
  return { ...actual, track: (...a: unknown[]) => h.track(...a) }
})

const CHECK_RUN: JevRun = {
  endpoint: 'classify',
  request: { model: 'm', premise: 'p', hypotheses: ['h1'] },
  response: {
    model: 'm',
    results: [{ hypothesis: 'Someone is preparing food.', label: 'entailment', probs: { contradiction: 0, entailment: 0.957, neutral: 0.043 } }],
    usage: { prompt_tokens: 69, total_tokens: 69 },
  },
  ms: 265,
}

const CHOOSE_RUN: JevRun = {
  endpoint: 'rerank',
  request: { model: 'm', query: 'What is the capital of France?', documents: ['Berlin', 'Paris', 'Madrid'] },
  response: {
    model: 'm',
    results: [
      { index: 1, document: { text: 'Paris' }, relevance_score: 0.941, label: 'entailment' },
      { index: 2, document: { text: 'Madrid' }, relevance_score: 0.016, label: 'contradiction' },
      { index: 0, document: { text: 'Berlin' }, relevance_score: 0.008, label: 'contradiction' },
    ],
    usage: { prompt_tokens: 51, total_tokens: 51 },
  },
  ms: 93,
}

const EXPECTED_CURL = [
  'curl http://localhost:6996/v1/classify \\',
  '  -H "content-type: application/json" \\',
  `  -d '{"model":"m","premise":"p","hypotheses":["h1"]}'`,
].join('\n')

function renderOutput(over: Partial<Parameters<typeof JevOutput>[0]> = {}) {
  const onView = vi.fn()
  const result = render(
    <JevOutput run={CHECK_RUN} view="results" onView={onView} origin="http://localhost:6996" {...over} />,
  )
  return { onView, ...result }
}

beforeEach(() => {
  h.track.mockReset()
  h.writeText.mockReset().mockResolvedValue(undefined)
  Object.defineProperty(navigator, 'clipboard', { value: { writeText: h.writeText }, configurable: true })
})

describe('JevOutput', () => {
  it('renders a classify run as labelled rows', () => {
    renderOutput()
    expect(screen.getByText('Someone is preparing food.')).toBeTruthy()
    expect(screen.getByText('0.957')).toBeTruthy()
  })

  it('renders a rerank run as ranked options', () => {
    renderOutput({ run: CHOOSE_RUN })
    expect(screen.getByText('Paris')).toBeTruthy()
    expect(screen.getByText('best')).toBeTruthy()
  })

  it('shows the response exactly as it arrived in the JSON view', () => {
    const { container } = renderOutput({ view: 'json' })
    expect(container.querySelector('pre')?.textContent).toBe(JSON.stringify(CHECK_RUN.response, null, 2))
  })

  it('shows the request as a runnable command in the API view', () => {
    const { container } = renderOutput({ view: 'api' })
    expect(container.querySelector('pre')?.textContent).toBe(EXPECTED_CURL)
  })

  it('copies that command, and records the copy as its own action', async () => {
    renderOutput({ view: 'api' })
    await userEvent.click(screen.getByRole('button', { name: 'Copy' }))
    expect(h.writeText).toHaveBeenCalledWith(EXPECTED_CURL)
    expect(h.track).toHaveBeenCalledWith('workspace', 'jev_copy_request')
  })

  it('says how many inputs were weighed, and how long it took', () => {
    renderOutput()
    expect(screen.getByText('1 pairs in 265 ms')).toBeTruthy()
  })

  it('counts options rather than pairs for a rerank', () => {
    renderOutput({ run: CHOOSE_RUN })
    expect(screen.getByText('3 options in 93 ms')).toBeTruthy()
  })

  it('asks for a run before it has one, in every view', () => {
    for (const view of ['results', 'json', 'api'] as const) {
      const { unmount } = renderOutput({ run: null, view })
      expect(screen.getByText('Run to see results.')).toBeTruthy()
      unmount()
    }
  })

  it('hands each view switch back to the caller, and records it', async () => {
    const { onView } = renderOutput()
    await userEvent.click(screen.getByRole('button', { name: 'JSON' }))
    expect(onView).toHaveBeenCalledWith('json')
    expect(h.track).toHaveBeenCalledWith('workspace', 'jev_view_json')

    await userEvent.click(screen.getByRole('button', { name: 'API' }))
    expect(onView).toHaveBeenCalledWith('api')
    expect(h.track).toHaveBeenCalledWith('workspace', 'jev_view_api')

    await userEvent.click(screen.getByRole('button', { name: 'Results' }))
    expect(onView).toHaveBeenCalledWith('results')
    expect(h.track).toHaveBeenCalledWith('workspace', 'jev_view_results')
  })
})
