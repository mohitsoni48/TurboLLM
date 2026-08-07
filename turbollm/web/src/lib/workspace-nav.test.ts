import { beforeEach, describe, expect, it } from 'vitest'
import { getLastWorkspacePath, rememberWorkspacePath, resolveNavTarget } from './workspace-nav'

describe('workspace-nav', () => {
  beforeEach(() => { sessionStorage.clear() })

  it('defaults to plain Chat when nothing has been remembered yet', () => {
    expect(getLastWorkspacePath()).toBe('/workspace/chat')
  })

  it('remembers a Code session sub-route and returns it later', () => {
    rememberWorkspacePath('/workspace/code/abc123')
    expect(getLastWorkspacePath()).toBe('/workspace/code/abc123')
  })

  it('remembers a Chat conversation sub-route', () => {
    rememberWorkspacePath('/workspace/chat/xyz789')
    expect(getLastWorkspacePath()).toBe('/workspace/chat/xyz789')
  })

  it('remembers Routines too', () => {
    rememberWorkspacePath('/workspace/routines/some-routine')
    expect(getLastWorkspacePath()).toBe('/workspace/routines/some-routine')
  })

  it('leaving Workspace for another section does not overwrite what was remembered', () => {
    rememberWorkspacePath('/workspace/code/abc123')
    rememberWorkspacePath('/usage')
    rememberWorkspacePath('/models')
    rememberWorkspacePath('/settings')
    expect(getLastWorkspacePath()).toBe('/workspace/code/abc123')
  })

  it('resolveNavTarget resolves the Workspace entry to the remembered path', () => {
    rememberWorkspacePath('/workspace/code/abc123')
    expect(resolveNavTarget('/workspace')).toBe('/workspace/code/abc123')
  })

  it('resolveNavTarget passes every other nav entry through unchanged', () => {
    rememberWorkspacePath('/workspace/code/abc123')
    expect(resolveNavTarget('/usage')).toBe('/usage')
    expect(resolveNavTarget('/models')).toBe('/models')
    expect(resolveNavTarget('/engines')).toBe('/engines')
    expect(resolveNavTarget('/customize')).toBe('/customize')
    expect(resolveNavTarget('/developer')).toBe('/developer')
    expect(resolveNavTarget('/settings')).toBe('/settings')
  })

  it('bare /workspace (not a real sub-route) is never remembered or returned', () => {
    rememberWorkspacePath('/workspace/code/abc123')
    rememberWorkspacePath('/workspace')
    expect(getLastWorkspacePath()).toBe('/workspace/code/abc123')
  })
})
