// QA F-5c: the Welcome step read "Ready — llama.cpp is installed" on a phone whose default engine is LiteRT-LM. It names
// the engine that is active, by the same label the Engines screen's selector shows.
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import WelcomeStep from './WelcomeStep'
import type { OnboardingCtx } from '../../../lib/onboarding/types'
import type { Engine } from '../../../lib/types'

const enginesState = vi.hoisted(() => ({ engines: [] as unknown[], activeEngineId: '' }))

vi.mock('../../../lib/queries', () => ({
  useStatus: () => ({ data: { engineProvision: { active: false, phase: 'done' } } }),
  useEngineBackends: () => ({ data: { gpus: [] } }),
  useEngines: () => ({ data: { engines: enginesState.engines, activeEngineId: enginesState.activeEngineId } }),
}))

const ctx: OnboardingCtx = {
  profile: 'casual',
  downloadDone: false,
  isT0: false,
  recommendationKind: 'entry',
  expectedModelKey: null,
  expectedDownloadId: null,
  loadCompletedOnce: false,
}

const row = (over: Partial<Engine> & { id: string; name: string }): Engine =>
  ({ binPath: '', version: '', capabilities: { kvTypes: [], flags: [] }, ...over })
const SDK_LITERT = row({
  id: 'lit', name: 'LiteRT-LM', kind: 'turbollm-sdk',
  sdkEngine: { id: 'litert-lm', kind: 'litert-lm', formats: ['litertlm'], backends: ['gpu', 'cpu'] },
})
const CUDA_LLAMA = row({ id: 'cuda', name: 'llama.cpp', kind: 'llama-server', binPath: '/x/engines/llama.cpp-b9736-cuda/llama-server' })

function renderWith(engines: Engine[], activeEngineId: string) {
  enginesState.engines = engines
  enginesState.activeEngineId = activeEngineId
  render(<WelcomeStep onContinue={vi.fn()} onSkip={vi.fn()} ctx={ctx} />)
}

describe('WelcomeStep engine readiness', () => {
  it('names LiteRT-LM when it is the active engine', () => {
    renderWith([SDK_LITERT], SDK_LITERT.id)
    expect(screen.getByText('Ready — LiteRT-LM is installed')).toBeTruthy()
    expect(screen.queryByText(/llama\.cpp/)).toBeNull()
  })

  it('names the active llama.cpp build on a desktop', () => {
    renderWith([CUDA_LLAMA], CUDA_LLAMA.id)
    expect(screen.getByText('Ready — llama.cpp (CUDA) is installed')).toBeTruthy()
  })

  it('reads as before while no engine is active yet', () => {
    renderWith([], '')
    expect(screen.getByText('Ready — llama.cpp is installed')).toBeTruthy()
  })
})
