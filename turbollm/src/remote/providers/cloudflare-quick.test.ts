import test from 'node:test'
import assert from 'node:assert/strict'
import { CloudflareQuickProvider, QUICK_URL_RE } from './cloudflare-quick'

test('cloudflare-quick: declares a child-process lifecycle', () => {
  const p = new CloudflareQuickProvider('/tmp/data')
  assert.equal(p.id, 'cloudflare-quick')
  assert.equal(p.lifecycle, 'child-process')
})

test('cloudflare-quick: preflight is always ready — no account, no token', async () => {
  const p = new CloudflareQuickProvider('/tmp/data')
  const state = await p.preflight()
  assert.equal(state.kind, 'off')
})

test('cloudflare-quick: parses the assigned URL out of cloudflared stderr', () => {
  const stderr = [
    '2026-09-10T10:00:00Z INF Requesting new quick Tunnel on trycloudflare.com...',
    '2026-09-10T10:00:01Z INF |  https://mellow-brook-1234.trycloudflare.com  |',
  ].join('\n')
  assert.equal(QUICK_URL_RE.exec(stderr)?.[0], 'https://mellow-brook-1234.trycloudflare.com')
})

test('cloudflare-quick: does not match a non-trycloudflare host', () => {
  assert.equal(QUICK_URL_RE.exec('https://example.com/trycloudflare.com'), null)
})

test('cloudflare-quick: builds the argv against the ingress port', () => {
  const p = new CloudflareQuickProvider('/tmp/data')
  assert.deepEqual(p.argv(6997), ['tunnel', '--url', 'http://127.0.0.1:6997'])
})
