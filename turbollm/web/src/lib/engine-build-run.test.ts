// engineBuildRunning: whether GET /status `engineBuild` is a build from source, during which the daemon refuses to
// add, enable, disable or delete an engine. The daemon says which runs are tool installs (toolInstall); the labels are
// only a fallback for a daemon that predates the field, since a build's name is the user's to pick.
import { describe, expect, it } from 'vitest'
import { engineBuildRunning, isToolInstall } from './engine-build-run'
import type { EngineBuild } from './types'

const run = (engine: string, toolInstall?: boolean): EngineBuild =>
  ({ active: true, phase: 'compiling', engine, log: [], error: null, toolInstall })

describe('engineBuildRunning', () => {
  it('counts a build from source named like a build tool as a build', () => {
    for (const name of ['cuda', 'git', 'cmake', 'gcc', 'CUDA Toolkit']) {
      expect(isToolInstall(run(name, false)), name).toBe(false)
      expect(engineBuildRunning(run(name, false)), name).toBe(true)
    }
  })

  it('does not count a tool install, whatever its label', () => {
    expect(engineBuildRunning(run('CUDA Toolkit', true))).toBe(false)
    expect(engineBuildRunning(run('make', true))).toBe(false)
  })

  it('falls back to the tool labels for a daemon that does not say', () => {
    expect(engineBuildRunning(run('cmake'))).toBe(false)
    expect(engineBuildRunning(run('ik_llama.cpp'))).toBe(true)
    expect(engineBuildRunning({ ...run('ik_llama.cpp'), active: false })).toBe(false)
    expect(engineBuildRunning(undefined)).toBe(false)
  })
})
