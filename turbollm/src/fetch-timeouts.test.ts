// Non-engine fetches must carry their own deadline: the daemon's global dispatcher has no 300 s backstop.
import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { fetchNpmLatest } from './app-update'
import { latestGithubRelease } from './engines/download'

const realFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = realFetch })

/** A fetch that never answers and only ends when its signal aborts, like a silent registry. */
function hangingFetch(seen: { signal?: AbortSignal | null }): typeof fetch {
  return ((_url: unknown, init?: RequestInit) => new Promise((_, reject) => {
    seen.signal = init?.signal
    init?.signal?.addEventListener('abort', () => reject(init.signal!.reason))
  })) as typeof fetch
}

test('fetchNpmLatest gives up on a registry that never answers', async () => {
  const seen: { signal?: AbortSignal | null } = {}
  globalThis.fetch = hangingFetch(seen)
  await assert.rejects(fetchNpmLatest(undefined, 30), (e: Error) => e.name === 'TimeoutError')
  assert.ok(seen.signal)
})

test('fetchNpmLatest still honours the caller signal', async () => {
  globalThis.fetch = hangingFetch({})
  const caller = new AbortController()
  const p = fetchNpmLatest(caller.signal)
  caller.abort(new Error('cancelled'))
  await assert.rejects(p, /cancelled/)
})

test('a GitHub release lookup carries a deadline signal', async () => {
  const seen: { signal?: AbortSignal | null } = {}
  globalThis.fetch = hangingFetch(seen)
  const p = latestGithubRelease('owner/repo').catch(() => {})
  assert.ok(seen.signal, 'no signal was passed, so the call could hang forever')
  assert.equal(seen.signal.aborted, false)
  const caller = new AbortController()
  const q = latestGithubRelease('owner/repo', caller.signal)
  caller.abort(new Error('cancelled'))
  await assert.rejects(q, /cancelled/)
  assert.equal(seen.signal.aborted, true)
  void p
})
