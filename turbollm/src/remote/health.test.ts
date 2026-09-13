import test from 'node:test'
import assert from 'node:assert/strict'
import { probeUrl, HEALTH_INTERVAL_MS } from './health'

test('health: probes /healthz on the public origin with no credential', async () => {
  let seen = ''
  let sentAuth: string | null = 'unset'
  const fake = (async (input: string | URL | Request, init?: RequestInit) => {
    seen = String(input)
    sentAuth = new Headers(init?.headers).get('X-TurboLLM-Auth')
    return new Response('{"ok":true}', { status: 200 })
  }) as unknown as typeof fetch
  assert.equal(await probeUrl('https://foo.trycloudflare.com', fake), true)
  assert.equal(seen, 'https://foo.trycloudflare.com/healthz')
  // /healthz is auth-exempt (auth.ts isExempt), so the probe must not need a token —
  // if it did, the probe would break the moment a user rotated their key.
  assert.equal(sentAuth, null)
})

test('health: a trailing slash on the URL does not produce a double slash', async () => {
  let seen = ''
  const fake = (async (input: string | URL | Request) => {
    seen = String(input)
    return new Response('', { status: 200 })
  }) as unknown as typeof fetch
  await probeUrl('https://foo.trycloudflare.com/', fake)
  assert.equal(seen, 'https://foo.trycloudflare.com/healthz')
})

test('health: a non-2xx is a failed probe', async () => {
  const fake = (async () => new Response('', { status: 502 })) as unknown as typeof fetch
  assert.equal(await probeUrl('https://foo.trycloudflare.com', fake), false)
})

test('health: a thrown network error is a failed probe, not an exception', async () => {
  const fake = (async () => {
    throw new Error('ECONNREFUSED')
  }) as unknown as typeof fetch
  assert.equal(await probeUrl('https://foo.trycloudflare.com', fake), false)
})

test('health: probes once a minute', () => {
  assert.equal(HEALTH_INTERVAL_MS, 60_000)
})
