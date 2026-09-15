import test from 'node:test'
import assert from 'node:assert/strict'
import type { Context } from 'hono'
import type { Deps } from './deps'
import { localPort, isLocalUpgrade, bypassesAuth } from './auth'
import { defaultConfig } from './config/config'

/** A Context carrying only what localPort reads: the node-server binding. */
const ctxOnPort = (port: number | undefined): Context =>
  ({ env: { incoming: { socket: { localPort: port } } } }) as unknown as Context

/** The `c.env.server` shape @hono/node-server uses when it wraps the binding. */
const ctxOnWrappedPort = (port: number): Context =>
  ({ env: { server: { incoming: { socket: { localPort: port } } } } }) as unknown as Context

const depsWithIngress = (port: number | undefined): Deps => {
  const cfg = defaultConfig()
  return {
    store: { snapshot: () => cfg, update: () => {}, dir: () => '' },
    remote: { ingressPort: () => port },
  } as unknown as Deps
}

test('localPort: reads the bare node-server binding', () => {
  assert.equal(localPort(ctxOnPort(6997)), 6997)
})

test('localPort: reads the wrapped c.env.server binding', () => {
  assert.equal(localPort(ctxOnWrappedPort(6997)), 6997)
})

test('localPort: returns undefined when there is no socket at all', () => {
  assert.equal(localPort({ env: {} } as unknown as Context), undefined)
})

test('isLocalUpgrade: a WebSocket arriving on the ingress port is NOT local', () => {
  const d = depsWithIngress(6997)
  assert.equal(isLocalUpgrade('127.0.0.1', 6997, {}, d), false)
})

test('isLocalUpgrade: a WebSocket on the main port from loopback IS local', () => {
  const d = depsWithIngress(6997)
  assert.equal(isLocalUpgrade('127.0.0.1', 6996, {}, d), true)
})

test('isLocalUpgrade: with no ingress listener at all, loopback is local', () => {
  const d = depsWithIngress(undefined)
  assert.equal(isLocalUpgrade('127.0.0.1', 6996, {}, d), true)
})

test('THE CRITICAL CASE: an ingress request that looks loopback must not bypass', () => {
  // Same assertion auth.test.ts makes for the cf-ray era, restated against the new signal:
  // tunneled is now derived from the socket, but bypassesAuth's own logic is unchanged.
  assert.equal(
    bypassesAuth({ lanBind: false, requireApiKey: true, tunneled: true, loopback: true, exempt: false }),
    false,
  )
})
