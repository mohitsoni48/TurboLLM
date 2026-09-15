import { describe, it, expect } from 'vitest'
import { classifyStatusError } from './connection-state'
import { ApiError } from './api'

// C2 (Phase 5 final-review-fix re-review, ADR-422): the SPA's own poll-failure handling used
// to treat every non-401 error (including a 403 from a capability-scoped remote token) as
// "daemon unreachable", so the feature's own headline "chat from your phone" journey ended on
// a non-dismissible "Lost connection" overlay a few seconds after load, even though the chat
// surface itself was fully reachable. Tests the REAL exported classifier App.tsx imports, not
// a re-derivation of it.
describe('classifyStatusError', () => {
  it('a 401 is needsAuth, not scopedTokenLimited', () => {
    const r = classifyStatusError(true, new ApiError('unauthorized', 'x', 401))
    expect(r).toEqual({ needsAuth: true, scopedTokenLimited: false })
  })

  it('a 403 is scopedTokenLimited, not needsAuth — the capability-scoped-token case', () => {
    const r = classifyStatusError(true, new ApiError('forbidden', 'x', 403))
    expect(r).toEqual({ needsAuth: false, scopedTokenLimited: true })
  })

  it('any other error status is neither — a genuine network failure still reaches the overlay', () => {
    expect(classifyStatusError(true, new ApiError('http_error', 'x', 500))).toEqual({ needsAuth: false, scopedTokenLimited: false })
    expect(classifyStatusError(true, new TypeError('fetch failed'))).toEqual({ needsAuth: false, scopedTokenLimited: false })
  })

  it('no error at all is neither', () => {
    expect(classifyStatusError(false, undefined)).toEqual({ needsAuth: false, scopedTokenLimited: false })
  })
})
