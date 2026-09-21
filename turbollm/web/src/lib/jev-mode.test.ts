// ADR-434 (b), (i)(1): while a Jev model is loaded, Workspace IS the playground.
//
// The rules live here, pure, because the mistake they guard against is a redirect loop:
// 'unknown' must never redirect (a Turbo Link token scoped to models:use cannot read
// /status, so "I can't tell" would otherwise read as "nothing loaded" and bounce a deep
// link the user typed on purpose).
import { describe, expect, it } from 'vitest'
import { JEV_PATH, isWorkspaceWorkPath, jevPresence, workspaceRedirect } from './jev-mode'
import type { JevInfo, JevStatus, ModelEntry, Status } from './types'

const JEV_INFO: JevInfo = {
  labels: ['contradiction', 'entailment', 'neutral'],
  nliTemplate: 'Premise: {premise}\nHypothesis: {hypothesis}',
  architecture: 'Qwen3_5ForSequenceClassification',
  verified: true,
}

const LOADED: JevStatus = {
  key: 'qwen3.5 4b nli v2|mlx-fp16|9012345678',
  name: 'qwen3.5 4b nli v2',
  labels: ['contradiction', 'entailment', 'neutral'],
  state: 'running',
  slot: 'primary',
}

function statusWith(jev: JevStatus | null): Status {
  return { jev } as unknown as Status
}

/** A status from a daemon that predates the field, or the Turbo Link façade's. */
function statusWithoutJevField(): Status {
  return {} as unknown as Status
}

function model(fields: Partial<ModelEntry>): ModelEntry {
  return fields as ModelEntry
}

describe('jevPresence', () => {
  it('reads a loaded Jev model straight off status', () => {
    expect(jevPresence(statusWith(LOADED), undefined)).toBe('loaded')
  })

  it('reads an explicit null as "none", even with a stale models list saying otherwise', () => {
    expect(jevPresence(statusWith(null), [model({ jev: JEV_INFO, loaded: true })])).toBe('none')
  })

  it('falls back to the models list when status carries no jev field at all', () => {
    expect(jevPresence(statusWithoutJevField(), [model({ jev: JEV_INFO, loaded: true })])).toBe('loaded')
    expect(jevPresence(statusWithoutJevField(), [model({ jev: JEV_INFO, loaded: false })])).toBe('none')
    expect(jevPresence(statusWithoutJevField(), [model({ loaded: true })])).toBe('none')
    expect(jevPresence(statusWithoutJevField(), [])).toBe('none')
  })

  it('is "unknown" while nothing has been read yet — never guessed as "none"', () => {
    expect(jevPresence(undefined, undefined)).toBe('unknown')
    expect(jevPresence(statusWithoutJevField(), undefined)).toBe('unknown')
  })

  it('uses the models list when status has not arrived yet', () => {
    expect(jevPresence(undefined, [model({ jev: JEV_INFO, loaded: true })])).toBe('loaded')
    expect(jevPresence(undefined, [])).toBe('none')
  })
})

describe('isWorkspaceWorkPath', () => {
  it('matches the three work sections and their sub-routes', () => {
    for (const p of ['/workspace/chat', '/workspace/code', '/workspace/routines']) {
      expect(isWorkspaceWorkPath(p)).toBe(true)
      expect(isWorkspaceWorkPath(`${p}/abc123`)).toBe(true)
    }
  })

  it('does not match a section whose name merely starts the same way', () => {
    expect(isWorkspaceWorkPath('/workspace/chatter')).toBe(false)
    expect(isWorkspaceWorkPath('/workspace/coder')).toBe(false)
    expect(isWorkspaceWorkPath('/workspace/routiness')).toBe(false)
  })

  it('does not match the playground, bare /workspace, or anything outside it', () => {
    expect(isWorkspaceWorkPath(JEV_PATH)).toBe(false)
    expect(isWorkspaceWorkPath('/workspace')).toBe(false)
    expect(isWorkspaceWorkPath('/models')).toBe(false)
    expect(isWorkspaceWorkPath('/chat/abc123')).toBe(false)
  })
})

describe('workspaceRedirect', () => {
  it('sends work routes to the playground, with the notice, while a Jev model is loaded', () => {
    expect(workspaceRedirect('/workspace/chat', 'loaded')).toEqual({ to: JEV_PATH, notice: true })
    expect(workspaceRedirect('/workspace/code/abc123', 'loaded')).toEqual({ to: JEV_PATH, notice: true })
    expect(workspaceRedirect('/workspace/routines/new', 'loaded')).toEqual({ to: JEV_PATH, notice: true })
  })

  it('leaves the playground itself alone while one is loaded', () => {
    expect(workspaceRedirect(JEV_PATH, 'loaded')).toBeNull()
    expect(workspaceRedirect(`${JEV_PATH}/anything`, 'loaded')).toBeNull()
  })

  it('sends the playground back to chat, without a notice, when none is loaded', () => {
    expect(workspaceRedirect(JEV_PATH, 'none')).toEqual({ to: '/workspace/chat', notice: false })
    expect(workspaceRedirect(`${JEV_PATH}/anything`, 'none')).toEqual({ to: '/workspace/chat', notice: false })
  })

  it('leaves the work routes alone when none is loaded', () => {
    expect(workspaceRedirect('/workspace/chat', 'none')).toBeNull()
    expect(workspaceRedirect('/workspace/code/abc123', 'none')).toBeNull()
  })

  it('never redirects on a guess — "unknown" leaves every route where it is', () => {
    expect(workspaceRedirect('/workspace/chat', 'unknown')).toBeNull()
    expect(workspaceRedirect(JEV_PATH, 'unknown')).toBeNull()
    expect(workspaceRedirect('/workspace/code/abc123', 'unknown')).toBeNull()
  })

  it('never touches a route outside Workspace, whatever is loaded', () => {
    for (const presence of ['unknown', 'none', 'loaded'] as const) {
      expect(workspaceRedirect('/models', presence)).toBeNull()
      expect(workspaceRedirect('/engines', presence)).toBeNull()
      expect(workspaceRedirect('/chat/abc123', presence)).toBeNull()
    }
  })

  it('leaves bare /workspace to the router, which already sends it to chat', () => {
    expect(workspaceRedirect('/workspace', 'loaded')).toBeNull()
    expect(workspaceRedirect('/workspace', 'none')).toBeNull()
  })
})
