// ADR-434 (b), (i)(1): while a Jev model is loaded, Workspace has exactly one mode. The gate is
// a pathless layout route over every /workspace* route, so a bookmark, a hardware Back button
// and an in-app link all land in the same place — and when nothing Jev is loaded it works in
// reverse, sending the playground's own URL back to Chat.
//
// Like App.redirects.test.tsx, this mounts the gate over probe routes rather than the whole
// <App/>: what is under test is which path the gate sends each URL to, not the app shell.
import { render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { WorkspaceModeGate } from './App'
import type { ModelEntry, Status } from './lib/types'

const state: { status: Status | undefined; models: ModelEntry[] | undefined } = {
  status: undefined,
  models: undefined,
}

vi.mock('./lib/queries', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./lib/queries')>()),
  useStatus: () => ({ data: state.status }),
  useModels: () => ({ data: state.models ? { models: state.models, scanning: false } : undefined }),
}))

const JEV = {
  key: 'jev-key',
  name: 'qwen3.5 4b nli v2',
  labels: ['contradiction', 'entailment', 'neutral'],
  state: 'running',
  slot: 'primary',
} as NonNullable<Status['jev']>

function Probe() {
  const loc = useLocation()
  return <div data-testid="landed">{`${loc.pathname} ${JSON.stringify(loc.state)}`}</div>
}

function landOn(path: string) {
  const view = render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route element={<WorkspaceModeGate />}>
          <Route path="/workspace/chat" element={<Probe />} />
          <Route path="/workspace/chat/:convId" element={<Probe />} />
          <Route path="/workspace/code/:sessionId" element={<Probe />} />
          <Route path="/workspace/routines" element={<Probe />} />
          <Route path="/workspace/jev" element={<Probe />} />
        </Route>
        <Route path="/models" element={<Probe />} />
      </Routes>
    </MemoryRouter>,
  )
  const landed = screen.getByTestId('landed').textContent
  view.unmount()
  return landed
}

beforeEach(() => {
  state.status = undefined
  state.models = undefined
})

describe('WorkspaceModeGate', () => {
  it('sends every Workspace work route to the playground while a Jev model is loaded', () => {
    state.status = { jev: JEV } as Status
    for (const path of ['/workspace/chat/abc', '/workspace/code/x', '/workspace/routines']) {
      expect(landOn(path)).toBe('/workspace/jev {"jevNotice":true}')
    }
  })

  it('leaves the playground itself alone', () => {
    state.status = { jev: JEV } as Status
    expect(landOn('/workspace/jev')).toBe('/workspace/jev null')
  })

  it('sends the playground back to Chat once nothing Jev is loaded, without an explanation', () => {
    state.status = { jev: null } as Status
    expect(landOn('/workspace/jev')).toBe('/workspace/chat {"jevNotice":false}')
  })

  it('never bounces a deep link on a guess', () => {
    expect(landOn('/workspace/chat/abc')).toBe('/workspace/chat/abc null')
  })

  it('reads the models list when the status cannot be read', () => {
    state.models = [{ key: 'jev-key', name: 'qwen3.5 4b nli v2', loaded: true, jev: { labels: [] } } as unknown as ModelEntry]
    expect(landOn('/workspace/chat/abc')).toBe('/workspace/jev {"jevNotice":true}')
  })

  it('has no opinion about routes outside Workspace', () => {
    state.status = { jev: JEV } as Status
    expect(landOn('/models')).toBe('/models null')
  })
})

describe('WorkspaceModeGate with a Laya model loaded', () => {
  const LAYA = { key: 'laya|laya|1455', name: 'laya', checkpoints: ['english'], state: 'running' } as NonNullable<Status['laya']>

  it('keeps the playground open', () => {
    state.status = { jev: null, laya: LAYA } as Status
    expect(landOn('/workspace/jev')).toBe('/workspace/jev null')
  })

  it('leaves chat, code and routines alone: a Laya model runs beside the chat model', () => {
    state.status = { jev: null, laya: LAYA } as Status
    expect(landOn('/workspace/chat/abc')).toBe('/workspace/chat/abc null')
  })
})
