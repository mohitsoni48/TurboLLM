import { describe, expect, it } from 'vitest'
import type { ModelChoice, ModelGroup } from './remote-models'
import {
  choiceMatches,
  filterModelGroups,
  moveActiveIndex,
  queryTokens,
  resolveActiveIndex,
} from './model-picker-filter'

function choice(over: Partial<ModelChoice> & { id: string; name: string }): ModelChoice {
  return { quant: null, remote: false, loaded: false, disabled: false, ...over }
}

const gemma = choice({ id: 'google/gemma-27b-GGUF/gemma-27b-Q4_K_M.gguf', name: 'Gemma 27B', quant: 'Q4_K_M' })
const qwen35 = choice({ id: 'unsloth/Qwen3-35B-GGUF/Q4_K_M.gguf', name: 'Qwen3 35B', quant: 'Q4_K_M' })
const qwen8 = choice({ id: 'unsloth/Qwen3-8B-GGUF/Q8_0.gguf', name: 'Qwen3 8B', quant: 'Q8_0' })
const remoteQwen = choice({
  id: 'workstation/qwen3-35b', name: 'Qwen3 35B', quant: 'Q4_K_M', remote: true, machine: 'workstation',
})

const local = (choices: ModelChoice[]): ModelGroup => ({ key: 'local', kind: 'local', label: 'This machine', choices })
const machine = (choices: ModelChoice[], note?: string): ModelGroup => ({
  key: 'l1', kind: 'machine', label: 'workstation', status: 'online', note, choices,
})

describe('queryTokens', () => {
  it('returns no tokens for a blank query', () => {
    expect(queryTokens('')).toEqual([])
    expect(queryTokens('   ')).toEqual([])
  })

  it('lower-cases and splits on whitespace', () => {
    expect(queryTokens('  Qwen  Q4 ')).toEqual(['qwen', 'q4'])
  })
})

describe('choiceMatches', () => {
  it.each([
    ['name', 'gemma', gemma],
    ['quant', 'q8_0', qwen8],
    ['machine', 'workstation', remoteQwen],
  ])('matches by %s', (_label, token, c) => {
    expect(choiceMatches(c, [token])).toBe(true)
  })

  it('matches the source repo owner and repo when one is given', () => {
    expect(choiceMatches(qwen35, ['unsloth'], 'unsloth/Qwen3-35B-GGUF')).toBe(true)
    expect(choiceMatches(qwen35, ['gguf'], 'unsloth/Qwen3-35B-GGUF')).toBe(true)
  })

  it('does not match an owner when no source repo is known', () => {
    expect(choiceMatches(qwen35, ['unsloth'])).toBe(false)
    expect(choiceMatches(qwen35, ['unsloth'], null)).toBe(false)
  })

  it('never matches the raw key, so size digits in a local key do not match', () => {
    const local = choice({ id: 'qwen3.6-35b-a3b|q4_k_m|13211155424', name: 'Qwen3.6 35B', quant: 'Q4_K_M' })
    expect(choiceMatches(local, ['132'])).toBe(false)
    expect(choiceMatches(local, ['13211155424'])).toBe(false)
  })

  it('requires every token (AND)', () => {
    const tokens = queryTokens('qwen q4')
    expect(choiceMatches(qwen35, tokens)).toBe(true)
    expect(choiceMatches(qwen8, tokens)).toBe(false)
    expect(choiceMatches(gemma, tokens)).toBe(false)
  })

  it('is case-insensitive', () => {
    expect(choiceMatches(gemma, queryTokens('GEMMA'))).toBe(true)
  })
})

describe('filterModelGroups', () => {
  it('finds a local model by the owner in its source repo, looked up by key', () => {
    const repos = new Map([[qwen35.id, 'unsloth/Qwen3-35B-GGUF']])
    const result = filterModelGroups([local([gemma, qwen35]), machine([remoteQwen])], 'unsloth', repos)
    expect(result.choices).toEqual([qwen35])
  })

  it('returns the groups unchanged for a blank query', () => {
    const groups = [local([gemma, qwen35]), machine([remoteQwen])]
    const result = filterModelGroups(groups, '  ')
    expect(result.groups).toBe(groups)
    expect(result.choices).toEqual([gemma, qwen35, remoteQwen])
  })

  it('preserves order (pinned-first input)', () => {
    const pinnedB = choice({ id: 'b', name: 'Beta' })
    const a = choice({ id: 'a', name: 'Alpha' })
    const c = choice({ id: 'c', name: 'Beta Two' })
    const result = filterModelGroups([local([pinnedB, a, c])], 'beta')
    expect(result.groups[0].choices).toEqual([pinnedB, c])
  })

  it('drops a group with no matches and a non-matching label', () => {
    const result = filterModelGroups([local([gemma]), machine([remoteQwen])], 'gemma')
    expect(result.groups.map((g) => g.key)).toEqual(['local'])
  })

  it('keeps an offline machine group matched by its label, with its note', () => {
    const offline = machine([], 'workstation did not answer')
    const result = filterModelGroups([local([gemma]), offline], 'workst')
    expect(result.groups).toHaveLength(1)
    expect(result.groups[0].key).toBe('l1')
    expect(result.groups[0].choices).toEqual([])
    expect(result.groups[0].note).toBe('workstation did not answer')
  })

  it('flattens the kept groups choices in render order', () => {
    const result = filterModelGroups([local([qwen35, gemma]), machine([remoteQwen])], 'qwen')
    expect(result.choices).toEqual([qwen35, remoteQwen])
  })

  it('does not mutate its input', () => {
    const groups = [local([gemma, qwen35])]
    filterModelGroups(groups, 'gemma')
    expect(groups[0].choices).toHaveLength(2)
  })
})

describe('moveActiveIndex', () => {
  it.each([
    ['ArrowDown', -1, 3, 0],
    ['ArrowUp', -1, 3, 2],
    ['ArrowDown', 2, 3, 2],
    ['ArrowUp', 0, 3, 0],
    ['ArrowDown', 0, 0, -1],
    ['ArrowUp', -1, 0, -1],
    ['Enter', 1, 3, 1],
    ['ArrowDown', 0, 3, 1],
    ['ArrowUp', 2, 3, 1],
  ])('%s from %i over %i -> %i', (key, index, count, expected) => {
    expect(moveActiveIndex(key, index, count)).toBe(expected)
  })
})

describe('resolveActiveIndex', () => {
  it.each([
    ['follows the row', 'b', ['a', 'b', 'E'], 2, true, 1],
    ['follows a row that moved', 'b', ['b', 'a', 'E'], 2, true, 0],
    ['vanished row with query -> first match', 'x', ['a', 'b', 'E'], 2, true, 0],
    ['vanished row, blank query -> none', 'x', ['a', 'b', 'E'], 2, false, -1],
    ['shrunk to zero never lands on Eject', 'x', ['E'], 0, true, -1],
    ['stays on Eject when the user moved there', 'E', ['a', 'E'], 1, true, 1],
    ['Eject as the only target when user moved there', 'E', ['E'], 0, true, 0],
    ['Eject gone -> first match', 'E', ['a', 'b'], 2, true, 0],
    ['no key, query -> first match', null, ['a', 'E'], 1, true, 0],
    ['no key, blank -> none', null, ['a', 'E'], 1, false, -1],
    ['no key, nothing visible -> none', null, [], 0, true, -1],
  ] as const)('%s', (_label, activeKey, targetKeys, choiceCount, hasQuery, expected) => {
    expect(resolveActiveIndex(activeKey, [...targetKeys], choiceCount, hasQuery, new Set())).toBe(expected)
  })

  describe('with disabled rows', () => {
    it.each([
      ['default skips a disabled first match', null, ['a', 'b', 'c', 'E'], 3, ['a'], 1],
      ['default skips several disabled matches', null, ['a', 'b', 'c', 'E'], 3, ['a', 'b'], 2],
      ['every match disabled -> no default, never Eject', null, ['a', 'b', 'E'], 2, ['a', 'b'], -1],
      ['vanished row falls back to the first pickable', 'x', ['a', 'b', 'E'], 2, ['a'], 1],
      ['an explicit key on a disabled row is respected', 'a', ['a', 'b', 'E'], 2, ['a'], 0],
    ] as const)('%s', (_label, activeKey, targetKeys, choiceCount, disabled, expected) => {
      expect(resolveActiveIndex(activeKey, [...targetKeys], choiceCount, true, new Set(disabled))).toBe(expected)
    })

    it('does not default-highlight anything with a blank query', () => {
      expect(resolveActiveIndex(null, ['a', 'b'], 2, false, new Set(['a']))).toBe(-1)
    })
  })
})
