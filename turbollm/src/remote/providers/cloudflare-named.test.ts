import test from 'node:test'
import assert from 'node:assert/strict'
import { CloudflareNamedProvider } from './cloudflare-named'

const cfg = { tunnelToken: 'eyJhIjoiMTIzIn0=', hostname: 'llm.example.com' }

test('cloudflare-named: is a child-process provider', () => {
  const p = new CloudflareNamedProvider('/tmp/data', cfg)
  assert.equal(p.id, 'cloudflare-named')
  assert.equal(p.lifecycle, 'child-process')
})

test('cloudflare-named: preflight needs a token', async () => {
  const p = new CloudflareNamedProvider('/tmp/data', { tunnelToken: '', hostname: 'llm.example.com' })
  const s = await p.preflight()
  assert.equal(s.kind, 'needs-setup')
  assert.equal(s.kind === 'needs-setup' && s.reason.includes('tunnel token'), true)
})

test('cloudflare-named: preflight needs a hostname', async () => {
  const p = new CloudflareNamedProvider('/tmp/data', { tunnelToken: 'tok', hostname: '' })
  const s = await p.preflight()
  assert.equal(s.kind, 'needs-setup')
  assert.equal(s.kind === 'needs-setup' && s.reason.includes('hostname'), true)
})

test('cloudflare-named: preflight rejects a hostname that is not a bare host', async () => {
  const p = new CloudflareNamedProvider('/tmp/data', { tunnelToken: 'tok', hostname: 'https://llm.example.com/chat' })
  const s = await p.preflight()
  assert.equal(s.kind, 'needs-setup')
})

test('cloudflare-named: preflight is ready with both', async () => {
  const p = new CloudflareNamedProvider('/tmp/data', cfg)
  assert.equal((await p.preflight()).kind, 'off')
})

test('cloudflare-named: argv runs the token form, never the quick-tunnel form, and never carries the token itself', () => {
  const p = new CloudflareNamedProvider('/tmp/data', cfg)
  assert.deepEqual(p.argv(), ['tunnel', 'run'])
})

test('cloudflare-named: the tunnel token travels as TUNNEL_TOKEN, not argv — readable via /proc/*/cmdline otherwise', () => {
  const p = new CloudflareNamedProvider('/tmp/data', cfg)
  assert.deepEqual(p.env(), { TUNNEL_TOKEN: cfg.tunnelToken })
  assert.equal(JSON.stringify(p.argv()).includes(cfg.tunnelToken), false)
})

test('cloudflare-named: the public URL comes from the configured hostname', () => {
  const p = new CloudflareNamedProvider('/tmp/data', cfg)
  assert.equal(p.publicUrl(), 'https://llm.example.com')
})
