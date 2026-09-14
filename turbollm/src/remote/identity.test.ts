import test from 'node:test'
import assert from 'node:assert/strict'
import type { Context } from 'hono'
import { tailscaleIdentity } from './identity'

const ctx = (headers: Record<string, string>): Context =>
  ({ req: { header: (n: string) => headers[n.toLowerCase()] } }) as unknown as Context

test('identity: reads the Tailscale Serve login header', () => {
  const id = tailscaleIdentity(ctx({ 'tailscale-user-login': 'sam@example.com', 'tailscale-user-name': 'Sam' }))
  assert.deepEqual(id, { login: 'sam@example.com', name: 'Sam' })
})

test('identity: name falls back to the login when only the login is present', () => {
  assert.deepEqual(tailscaleIdentity(ctx({ 'tailscale-user-login': 'sam@example.com' })), {
    login: 'sam@example.com',
    name: 'sam@example.com',
  })
})

test('identity: no header is no identity — which is every Funnel request, by design', () => {
  assert.equal(tailscaleIdentity(ctx({})), null)
})

test('identity: an empty header is not an identity', () => {
  assert.equal(tailscaleIdentity(ctx({ 'tailscale-user-login': '   ' })), null)
})
