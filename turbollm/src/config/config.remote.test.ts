import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defaultConfig, ConfigStore, normalizeProvider, resolveIngressPort } from './config'

// `normalize` is module-private; it runs on every load. Exercise it the way
// config.link.test.ts's own `loadRaw` does — write a real config.json to a temp dir and
// load it through ConfigStore.load, so migrate()+normalize() run for real against a genuine
// file, not a helper that only pretends to.
function loadRaw(raw: unknown) {
  const dir = mkdtempSync(join(tmpdir(), 'tllm-remote-cfg-'))
  const path = join(dir, 'config.json')
  writeFileSync(path, JSON.stringify(raw), 'utf8')
  return ConfigStore.load(path).snapshot()
}

test('remoteAccess: defaults are off, quick tunnel, ingress 6997', () => {
  const c = defaultConfig()
  assert.equal(c.remoteAccess.enabled, false)
  assert.equal(c.remoteAccess.provider, 'cloudflare-quick')
  assert.equal(c.remoteAccess.ingressPort, 6997)
  assert.equal(c.remoteAccess.cloudflare.tunnelToken, '')
  assert.equal(c.remoteAccess.cloudflare.requireAccess, false)
  assert.equal(c.remoteAccess.tailscale.port, 443)
  assert.deepEqual(c.remoteAccess.tokenGrant.capabilities, ['models:use'])
  assert.equal(c.remoteAccess.lastUrl, '')
})

test('remoteAccess: an absent block normalizes to defaults (no migration needed)', () => {
  // A config.json written before ADR-422 simply has no remoteAccess key at all — that is
  // the real shape an upgrading user's file takes, not a partial with the field explicitly
  // set to undefined (JSON has no way to write a key as undefined; it is just missing).
  const c = loadRaw({})
  assert.equal(c.remoteAccess.enabled, false)
  assert.equal(c.remoteAccess.provider, 'cloudflare-quick')
})

test('remoteAccess: ingressPort colliding with daemon.port is moved apart', () => {
  const c = defaultConfig()
  c.daemon.port = 6997
  c.remoteAccess.ingressPort = 6997
  const fixed = resolveIngressPort(c.remoteAccess.ingressPort, c.daemon.port)
  assert.notEqual(fixed, c.daemon.port)
  assert.equal(fixed, 6996)
})

test('remoteAccess: a non-colliding ingressPort is left alone', () => {
  assert.equal(resolveIngressPort(6997, 6996), 6997)
})

test('remoteAccess: an unknown provider falls back to cloudflare-quick', () => {
  const c = loadRaw({ remoteAccess: { provider: 'not-a-real-provider' } })
  assert.equal(c.remoteAccess.provider, 'cloudflare-quick')
  assert.equal(normalizeProvider('not-a-provider'), 'cloudflare-quick')
  assert.equal(normalizeProvider('tailscale-serve'), 'tailscale-serve')
})
