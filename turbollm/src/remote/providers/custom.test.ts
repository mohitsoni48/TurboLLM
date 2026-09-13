import test from 'node:test'
import assert from 'node:assert/strict'
import { CustomProvider } from './custom'

test('custom: has no lifecycle to manage', () => {
  const p = new CustomProvider({ publicUrl: 'https://llm.example.com' })
  assert.equal(p.id, 'custom')
  assert.equal(p.lifecycle, 'none')
})

test('custom: preflight needs a URL', async () => {
  const s = await new CustomProvider({ publicUrl: '' }).preflight()
  assert.equal(s.kind, 'needs-setup')
})

test('custom: preflight rejects a URL that is not absolute http(s)', async () => {
  assert.equal((await new CustomProvider({ publicUrl: 'llm.example.com' }).preflight()).kind, 'needs-setup')
  assert.equal((await new CustomProvider({ publicUrl: 'ftp://llm.example.com' }).preflight()).kind, 'needs-setup')
})

test('custom: start returns the configured URL with any trailing slash trimmed', async () => {
  const p = new CustomProvider({ publicUrl: 'https://llm.example.com/' })
  assert.equal((await p.start(6997)).url, 'https://llm.example.com')
})

test('custom: stop is a no-op and alive tracks only whether we were started', async () => {
  const p = new CustomProvider({ publicUrl: 'https://llm.example.com' })
  assert.equal(p.alive(), false)
  await p.start(6997)
  assert.equal(p.alive(), true)
  await p.stop()
  assert.equal(p.alive(), false)
})
