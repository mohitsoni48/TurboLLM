import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createApp, registerCodeRoutesIfSupported, registerSpaFallback } from './server'
import type { Deps } from './deps'

const RAW_KEY = 'tllm-route-order-test-key'

/** Regression test for the bug that made every `/api/v1/code/*` route 404 with "Unknown
 *  endpoint." from a7a85c2 onward (v1.12.5 through v1.13.0, reported by many users): that
 *  commit moved Code/Agents route registration out of `createApp()` to run lazily afterward
 *  (`registerCodeRoutesIfSupported`), by which point `createApp()` had already registered the
 *  SPA's catch-all `GET /*`. Hono matches an overlapping catch-all in registration order, so
 *  the specific Code routes added later were silently unreachable — the request fell through
 *  to the catch-all's 404 first. This drives the REAL boot sequence (`createApp` +
 *  `registerCodeRoutesIfSupported` + `registerSpaFallback`, in that order, exactly like
 *  cli.ts), not a hand-composed mini-app, because the defect was the ordering between those
 *  calls — a test that re-declares the order would pass against the broken build. */

function mkDeps(): Deps {
  // Same minimal-double approach as server.link-telemetry.test.ts: `createApp` wires every
  // route module, several of which touch the DB at registration time (e.g.
  // CodeRunManager.reconcileOnStartup). A Proxy answering every call with `[]` is sufficient
  // since this test is about routing order, not those modules' business logic.
  const db = new Proxy({}, { get: () => () => [] })
  const cfg: Record<string, unknown> = {
    // No `grant` field — a key that carries one is a Turbo Link facade-only credential and
    // is refused by verifyKeyValue/isFacadeOnlyKey (ADR-376) for every other auth surface,
    // codeAuth included.
    apiKeys: [{
      id: 'k1', name: 'test', hash: createHash('sha256').update(RAW_KEY).digest('hex'),
      prefix: RAW_KEY.slice(0, 12), createdAt: 'c', lastUsedAt: null,
    }],
    links: [],
    // isLocalRequest (auth.ts) can't see a real loopback socket through Hono's fake
    // `.request()` dispatch, so codeAuth would 401 every call without a key on file too —
    // this mirrors server.link-telemetry.test.ts's own workaround for the same gap.
    daemon: { lanBind: true, requireApiKey: false, machineId: 'machine-test', port: 6996 },
  }
  return {
    version: 'test',
    store: { snapshot: () => cfg, update: (fn: (c: never) => void) => fn(cfg as never), dir: () => '.' },
    db,
    telemetry: { firstUse: () => {}, useFeature: () => {} },
  } as unknown as Deps
}

test('Code routes are reachable after the real createApp + registerCodeRoutesIfSupported + registerSpaFallback boot sequence', async () => {
  const d = mkDeps()
  const app = createApp(d)
  await registerCodeRoutesIfSupported(app, d)
  registerSpaFallback(app)

  const res = await app.request('/api/v1/code/sessions', { headers: { 'X-TurboLLM-Auth': RAW_KEY } })
  const body = await res.json()
  assert.equal(res.status, 200, `expected the real Code route to answer, got ${JSON.stringify(body)}`)
  assert.deepEqual(body, { sessions: [] })
})

test('the SPA catch-all still 404s unknown /api paths that no route module claimed', async () => {
  const d = mkDeps()
  const app = createApp(d)
  await registerCodeRoutesIfSupported(app, d)
  registerSpaFallback(app)

  const res = await app.request('/api/v1/this-route-does-not-exist')
  assert.equal(res.status, 404)
  assert.deepEqual(await res.json(), { error: { code: 'not_found', message: 'Unknown endpoint.' } })
})
