// Non-engine fetches must carry their own deadline: the daemon's global dispatcher has no 300 s backstop.
import assert from 'node:assert/strict'
import { afterEach, beforeEach, test } from 'node:test'
import { fetchNpmLatest } from './app-update'
import { latestGithubRelease } from './engines/download'

const realFetch = globalThis.fetch
// AbortSignal.timeout() runs on an unref'd timer and the hanging fetch below holds no handle, so on a quiet worker
// nothing keeps the event loop alive: it empties before the deadline fires and node:test cancels the file with
// "Promise resolution is still pending but the event loop has already resolved". Hold a ref'd handle per test.
let keepAlive: NodeJS.Timeout
beforeEach(() => { keepAlive = setInterval(() => {}, 1000) })
afterEach(() => { clearInterval(keepAlive); globalThis.fetch = realFetch })

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
