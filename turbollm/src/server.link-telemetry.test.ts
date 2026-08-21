import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createApp } from './server'
import type { Deps } from './deps'

/** Regression test for the ADR-376 final review's I-1.
 *
 *  `registerLinkApi` used to be registered ABOVE the feature-telemetry middleware in
 *  `createApp`. Hono composes matching handlers in registration order, and a handler that
 *  returns without calling `next()` short-circuits everything registered after it — so the
 *  `link` feature was recorded for exactly one case: a 404 on a `/api/link/v1/*` path the
 *  façade does not serve. A metric that only fires on failures is worse than none.
 *
 *  This drives the REAL `createApp`, not a hand-composed mini-app, because the defect was
 *  the ordering inside that function — a test that re-declares the order would have passed
 *  against the broken build. */

const RAW = 'tllm-link-telemetry-test-key'

function mkDeps(recorded: string[]): Deps {
  const cfg: Record<string, unknown> = {
    apiKeys: [{
      id: 'k1', name: 'link:peer', hash: createHash('sha256').update(RAW).digest('hex'),
      prefix: RAW.slice(0, 12), createdAt: 'c', lastUsedAt: null,
      grant: { capabilities: ['models:use'] },
    }],
    links: [],
    daemon: { lanBind: true, requireApiKey: true, machineId: 'machine-abc', port: 6996 },
  }
  return {
    version: '1.11.2',
    store: {
      snapshot: () => cfg,
      update: (fn: (c: never) => void) => fn(cfg as never),
      dir: () => '.',
    },
    // `createApp` wires every route module, a few of which touch the DB at registration
    // time (CodeRunManager.reconcileOnStartup). This test is about middleware ORDER, not
    // about those modules, so the DB is a stub that answers every call with an empty list.
    db: new Proxy({}, { get: () => () => [] }),
    telemetry: {
      firstUse: (f: string) => recorded.push(`first:${f}`),
      useFeature: (f: string) => recorded.push(`use:${f}`),
    },
  } as unknown as Deps
}

test('a successful Turbo Link hello is attributed to the link feature', async () => {
  const recorded: string[] = []
  const res = await createApp(mkDeps(recorded)).request('/api/link/v1/hello', {
    method: 'POST',
    headers: { 'X-TurboLLM-Auth': RAW },
  })
  assert.equal(res.status, 200)
  assert.ok(recorded.includes('first:link'), `expected the link feature to be recorded, got ${JSON.stringify(recorded)}`)
  assert.ok(recorded.includes('use:link'))
})

test('a REJECTED Turbo Link call is not counted as feature usage', async () => {
  // The gate stays above the telemetry middleware for this reason: an unauthenticated
  // peer hammering the façade must not look like the user discovering the feature.
  const recorded: string[] = []
  const res = await createApp(mkDeps(recorded)).request('/api/link/v1/hello', { method: 'POST' })
  assert.equal(res.status, 401)
  assert.deepEqual(recorded, [])
})
