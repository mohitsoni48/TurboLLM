import { describe, expect, it } from 'vitest'
import { branchOptions } from './branch-options'

const FETCHED = ['master', 'dev', 'cuda-a', 'cuda-b']

describe('branchOptions', () => {
  it('lists the fetched branches as they are when nothing is typed', () => {
    expect(branchOptions('master', FETCHED, '')).toEqual({ options: FETCHED, matched: 4 })
  })

  it('adds the selected branch when the fetched list does not contain it, without counting it as fetched', () => {
    // '' = "repo default": selected and sent, but not a branch GitHub returned.
    expect(branchOptions('', FETCHED, '')).toEqual({ options: ['', ...FETCHED], matched: 4 })
  })

  it('keeps the selected branch listed when the search filters it out', () => {
    // Without it the <select> shows the first match while the build request still sends `master`.
    expect(branchOptions('master', FETCHED, 'cuda')).toEqual({ options: ['master', 'cuda-a', 'cuda-b'], matched: 2 })
  })

  it('leaves the selected branch where it is when the search matches it', () => {
    expect(branchOptions('cuda-b', FETCHED, 'cuda')).toEqual({ options: ['cuda-a', 'cuda-b'], matched: 2 })
  })

  it('offers only the selected branch when nothing matches', () => {
    expect(branchOptions('master', FETCHED, 'zzz')).toEqual({ options: ['master'], matched: 0 })
  })

  it('matches without regard to case', () => {
    expect(branchOptions('master', FETCHED, 'CUDA-A')).toEqual({ options: ['master', 'cuda-a'], matched: 1 })
  })

  it('never lists the selected branch twice', () => {
    const { options } = branchOptions('dev', FETCHED, 'dev')
    expect(options.filter((b) => b === 'dev')).toHaveLength(1)
  })
})
