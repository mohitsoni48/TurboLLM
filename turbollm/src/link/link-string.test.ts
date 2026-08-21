import { test } from 'node:test'
import assert from 'node:assert/strict'
import { encodeLinkString, decodeLinkString } from './link-string'

test('round-trips a LAN URL and token', () => {
  const s = encodeLinkString('http://192.168.1.9:6996', 'tllm-abc123')
  assert.deepEqual(decodeLinkString(s), { baseUrl: 'http://192.168.1.9:6996', token: 'tllm-abc123' })
})

test('round-trips a tunnel URL', () => {
  const s = encodeLinkString('https://fuzzy-cat-1234.trycloudflare.com', 'tllm-xyz')
  assert.deepEqual(decodeLinkString(s), {
    baseUrl: 'https://fuzzy-cat-1234.trycloudflare.com', token: 'tllm-xyz',
  })
})

test('normalises away a trailing slash so the peer never builds a double-slash URL', () => {
  const s = encodeLinkString('https://host.example/', 'tllm-x')
  assert.equal(decodeLinkString(s)!.baseUrl, 'https://host.example')
})

test('tolerates surrounding whitespace from a sloppy paste', () => {
  const s = encodeLinkString('http://h:6996', 'tllm-x')
  assert.deepEqual(decodeLinkString(`  ${s}\n`), { baseUrl: 'http://h:6996', token: 'tllm-x' })
})

test('returns null on junk rather than throwing', () => {
  // The user WILL paste the wrong thing. Every one of these must be a friendly
  // "that does not look like a link string", never an exception in the UI.
  assert.equal(decodeLinkString(''), null)
  assert.equal(decodeLinkString('hello'), null)
  assert.equal(decodeLinkString('tllink_@@@@'), null)
  assert.equal(decodeLinkString('tllink_' + Buffer.from('{}').toString('base64url')), null)
  assert.equal(decodeLinkString('tllink_' + Buffer.from('not json').toString('base64url')), null)
})

test('rejects a non-http scheme', () => {
  // A pasted string is untrusted input; file:// or javascript: must never become a baseUrl.
  const bad = 'tllink_' + Buffer.from(JSON.stringify({ u: 'file:///etc/passwd', t: 'x' })).toString('base64url')
  assert.equal(decodeLinkString(bad), null)
})
