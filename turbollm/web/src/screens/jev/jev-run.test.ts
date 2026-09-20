// What the Run button does (ADR-434 (c), (d)): validate the draft, send exactly the fields the
// endpoint takes, and time the round trip.
//
// The body assertions are strict on purpose. The API view shows the user this exact request and
// invites them to paste it into a shell, so an extra field here becomes an extra field in the
// documentation people copy — and `hypothesis_template` in particular is API-only ((d): the
// playground keeps the default).
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { checkDraftError, chooseDraftError, runCheck, runChoose } from './jev-run'
import type { ClassifyResponse, RerankResponse } from '../../lib/types'

const h = vi.hoisted(() => ({ classify: vi.fn(), rerank: vi.fn() }))

vi.mock('../../lib/jev-api', () => ({
  classify: (req: unknown) => h.classify(req),
  rerank: (req: unknown) => h.rerank(req),
}))

const CLASSIFIED: ClassifyResponse = {
  model: 'jev-key',
  results: [{ hypothesis: 'Someone is preparing food.', label: 'entailment', probs: { contradiction: 0, entailment: 0.957, neutral: 0.043 } }],
  usage: { prompt_tokens: 69, total_tokens: 69 },
}

const RANKED: RerankResponse = {
  model: 'jev-key',
  results: [{ index: 1, document: { text: 'Paris' }, relevance_score: 0.941, label: 'entailment' }],
  usage: { prompt_tokens: 51, total_tokens: 51 },
}

beforeEach(() => {
  vi.restoreAllMocks()
  h.classify.mockReset().mockResolvedValue(CLASSIFIED)
  h.rerank.mockReset().mockResolvedValue(RANKED)
})

/** performance.now() answers 100 then 172 — a 72 ms round trip. */
function stubClock() {
  const now = vi.fn().mockReturnValueOnce(100).mockReturnValueOnce(172)
  vi.spyOn(performance, 'now').mockImplementation(now)
}

describe('checkDraftError', () => {
  it('asks for a premise before anything else', () => {
    expect(checkDraftError({ premise: '', hypotheses: ['Someone is preparing food.'] })).toBe('Enter a premise first')
    expect(checkDraftError({ premise: '   ', hypotheses: ['Someone is preparing food.'] })).toBe('Enter a premise first')
  })

  it('asks for a hypothesis when every row is blank', () => {
    expect(checkDraftError({ premise: 'A chef is chopping onions.', hypotheses: [] })).toBe('Add at least one hypothesis')
    expect(checkDraftError({ premise: 'A chef is chopping onions.', hypotheses: ['', '  '] })).toBe('Add at least one hypothesis')
  })

  it('is happy with a premise and one real hypothesis', () => {
    expect(checkDraftError({ premise: 'A chef is chopping onions.', hypotheses: ['', 'Someone is preparing food.'] })).toBeNull()
  })
})

describe('chooseDraftError', () => {
  it('asks for a question before anything else', () => {
    expect(chooseDraftError({ question: '', options: ['Berlin', 'Paris'] })).toBe('Enter a question first')
    expect(chooseDraftError({ question: '  ', options: ['Berlin', 'Paris'] })).toBe('Enter a question first')
  })

  it('needs two real options — ranking one thing answers nothing', () => {
    expect(chooseDraftError({ question: 'What is the capital of France?', options: ['Paris'] })).toBe('Add at least two options')
    expect(chooseDraftError({ question: 'What is the capital of France?', options: ['Paris', '  '] })).toBe('Add at least two options')
  })

  it('is happy with a question and two real options', () => {
    expect(chooseDraftError({ question: 'What is the capital of France?', options: ['Berlin', ' ', 'Paris'] })).toBeNull()
  })
})

describe('runCheck', () => {
  it('sends the trimmed premise and only the hypotheses the user actually wrote', async () => {
    stubClock()
    await runCheck('jev-key', { premise: '  A chef is chopping onions.  ', hypotheses: ['  Someone is preparing food.  ', '', '   '] })
    expect(h.classify).toHaveBeenCalledWith({
      model: 'jev-key',
      premise: 'A chef is chopping onions.',
      hypotheses: ['Someone is preparing food.'],
    })
  })

  it('returns the request, the response and the round trip in whole milliseconds', async () => {
    stubClock()
    const run = await runCheck('jev-key', { premise: 'A chef is chopping onions.', hypotheses: ['Someone is preparing food.'] })
    expect(run.endpoint).toBe('classify')
    expect(run.request).toEqual({ model: 'jev-key', premise: 'A chef is chopping onions.', hypotheses: ['Someone is preparing food.'] })
    expect(run.response).toEqual(CLASSIFIED)
    expect(run.ms).toBe(72)
  })
})

describe('runChoose', () => {
  it('sends the trimmed question and options, and no hypothesis_template', async () => {
    stubClock()
    await runChoose('jev-key', { question: '  What is the capital of France?  ', options: ['  Berlin  ', '', 'Paris'] })
    expect(h.rerank).toHaveBeenCalledWith({
      model: 'jev-key',
      query: 'What is the capital of France?',
      documents: ['Berlin', 'Paris'],
    })
    expect(Object.keys(h.rerank.mock.calls[0][0] as object).sort()).toEqual(['documents', 'model', 'query'])
  })

  it('returns the request, the response and the round trip in whole milliseconds', async () => {
    stubClock()
    const run = await runChoose('jev-key', { question: 'What is the capital of France?', options: ['Berlin', 'Paris'] })
    expect(run.endpoint).toBe('rerank')
    expect(run.response).toEqual(RANKED)
    expect(run.ms).toBe(72)
  })

  it('rounds a fractional round trip rather than showing "71.6 ms"', async () => {
    vi.spyOn(performance, 'now').mockReturnValueOnce(100).mockReturnValueOnce(171.6)
    const run = await runChoose('jev-key', { question: 'q', options: ['a', 'b'] })
    expect(run.ms).toBe(72)
  })
})
