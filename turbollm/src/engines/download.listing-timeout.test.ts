// Review L5: a release LISTING (per_page=100, up to three pages) parses bodies that can run to megabytes, so the 30 s
// total API deadline, which covers res.json() too, could cut a slow but healthy listing off. Each listing call gets the
// longer listing deadline; a single-release lookup keeps the API one. Nothing touches the network: fetch is stubbed.
import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { fetchTurboquantPlan, latestBuildTagRelease, latestGithubRelease } from './download'
import { API_TIMEOUT_MS, LISTING_TIMEOUT_MS } from '../util/fetch-timeout'

/** Records the deadline every AbortSignal.timeout() is asked for while `run` fetches against a stub. */
async function deadlinesOf(t: TestContext, body: unknown, run: () => Promise<unknown>): Promise<number[]> {
  const asked: number[] = []
  const realTimeout = AbortSignal.timeout.bind(AbortSignal)
  t.mock.method(AbortSignal, 'timeout', (ms: number) => { asked.push(ms); return realTimeout(ms) })
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify(body), { status: 200 }))
  await run()
  return asked
}

test('listing a repo\'s releases (TurboQuant plan) uses the listing deadline', async (t) => {
  const hw = { platform: 'linux', arch: 'x64', vendor: 'unknown' as const, hasGpu: false, driverCuda: null, computeCaps: [] }
  assert.deepEqual(await deadlinesOf(t, [], () => fetchTurboquantPlan('o/r', hw)), [LISTING_TIMEOUT_MS])
})

test('latestBuildTagRelease (a per_page=100 listing) uses the listing deadline', async (t) => {
  assert.deepEqual(await deadlinesOf(t, [{ tag_name: 'b100' }], () => latestBuildTagRelease('o/r')), [LISTING_TIMEOUT_MS])
})

test('a single-release lookup keeps the API deadline', async (t) => {
  assert.deepEqual(await deadlinesOf(t, { tag_name: 'v1', assets: [] }, () => latestGithubRelease('o/r')), [API_TIMEOUT_MS])
  assert.equal(LISTING_TIMEOUT_MS, 120_000)
})
