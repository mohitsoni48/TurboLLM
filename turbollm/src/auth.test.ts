import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { bypassesAuth, isLocalRequest, isLocalOrAuthenticated, provisionTunnelApiKey, verifyPresentedKey, codeAuth } from './auth'
import type { Context } from 'hono'
import type { Deps } from './deps'

// Regression tests for ADR-152: a Cloud Launch tunnel's local leg connects via
// 127.0.0.1, same as a genuinely local caller — so a request that actually traversed
// the tunnel must never bypass auth via the loopback check. `tunneled` below is the
// per-REQUEST signal (verified against a live cloudflared tunnel: Cloudflare's edge
// injects cf-ray/cf-connecting-ip on every proxied request; a direct local request has
// neither) — NOT a whole-daemon "a tunnel is active somewhere" flag, since that
// broader form would also block the daemon's own local CLI tooling (--stop, launch).

test('bypassesAuth: default state (no LAN, no tunnel) is a pure pass-through', () => {
  assert.equal(
    bypassesAuth({ lanBind: false, requireApiKey: true, tunneled: false, loopback: true, exempt: false }),
    true,
  )
  assert.equal(
    bypassesAuth({ lanBind: false, requireApiKey: true, tunneled: false, loopback: null, exempt: false }),
    true,
  )
})

test('bypassesAuth: LAN-exposed + loopback caller still bypasses (today\'s local-browser case)', () => {
  assert.equal(
    bypassesAuth({ lanBind: true, requireApiKey: true, tunneled: false, loopback: true, exempt: false }),
    true,
  )
})

test('bypassesAuth: LAN-exposed + remote caller without a key is rejected', () => {
  assert.equal(
    bypassesAuth({ lanBind: true, requireApiKey: true, tunneled: false, loopback: false, exempt: false }),
    false,
  )
})

test('bypassesAuth: LAN-exposed with requireApiKey off is open access', () => {
  assert.equal(
    bypassesAuth({ lanBind: true, requireApiKey: false, tunneled: false, loopback: false, exempt: false }),
    true,
  )
})

test('bypassesAuth: THE CRITICAL CASE — a tunneled request that looks loopback must NOT bypass', () => {
  // Exactly what a request arriving through cloudflared's local leg looks like: lanBind
  // is false (daemon never toggled LAN), the connection appears loopback, but it's
  // flagged as tunneled (cf-ray was present). Must require a key.
  assert.equal(
    bypassesAuth({ lanBind: false, requireApiKey: true, tunneled: true, loopback: true, exempt: false }),
    false,
  )
})

test('bypassesAuth: a genuinely local request (no cf-ray) still bypasses even while a tunnel is active elsewhere', () => {
  // The daemon's own --stop/launch CLI tooling, or a local curl on the box: no
  // Cloudflare headers, so `tunneled` is false for THIS request even though the
  // tunnel itself is running. Must NOT be blocked.
  assert.equal(
    bypassesAuth({ lanBind: false, requireApiKey: true, tunneled: false, loopback: true, exempt: false }),
    true,
  )
})

test('bypassesAuth: tunneled request ignores requireApiKey=false — always enforced', () => {
  assert.equal(
    bypassesAuth({ lanBind: false, requireApiKey: false, tunneled: true, loopback: true, exempt: false }),
    false,
  )
})

test('bypassesAuth: tunneled request still exempts the SPA shell + healthz', () => {
  assert.equal(
    bypassesAuth({ lanBind: false, requireApiKey: true, tunneled: true, loopback: true, exempt: true }),
    true,
  )
})

test('bypassesAuth: tunneled + a genuinely remote caller (loopback=false) is still rejected without a key', () => {
  assert.equal(
    bypassesAuth({ lanBind: false, requireApiKey: true, tunneled: true, loopback: false, exempt: false }),
    false,
  )
})

// isLocalRequest gates local-admin actions that execute a caller-supplied binary
// (add/scan engine, build-from-source, CUDA download) — a request that actually
// traversed the tunnel must not reach these just because it LOOKS loopback, but the
// daemon's own genuinely-local access (no Cloudflare headers) must be unaffected.

function fakeDeps(overrides: { lanBind?: boolean; tunnelActive?: boolean; requireApiKey?: boolean }): Deps {
  return {
    store: { snapshot: () => ({ daemon: { lanBind: overrides.lanBind ?? false, requireApiKey: overrides.requireApiKey ?? false } } as ReturnType<Deps['store']['snapshot']>) },
    tunnel: overrides.tunnelActive !== undefined ? ({ active: () => overrides.tunnelActive } as Deps['tunnel']) : undefined,
  } as unknown as Deps
}

function fakeContext(headers: Record<string, string | undefined>): Context {
  return { req: { header: (name: string) => headers[name.toLowerCase()] } } as unknown as Context
}

test('isLocalRequest: a tunneled request (cf-ray present) is never local, even though it looks loopback', () => {
  const d = fakeDeps({ lanBind: false, tunnelActive: true })
  const c = fakeContext({ 'cf-ray': 'abc123-DEL' })
  assert.equal(isLocalRequest(c, d), false)
})

test('isLocalRequest: tunnel active but THIS request carries no Cloudflare headers is still local', () => {
  // The exact case that broke --stop/launch under the earlier (overbroad) fix: the
  // tunnel is running, but this particular request is genuinely local.
  const d = fakeDeps({ lanBind: false, tunnelActive: true })
  const c = fakeContext({})
  assert.equal(isLocalRequest(c, d), true)
})

test('isLocalRequest: loopback-only bind with no tunnel at all is still always local (unchanged behavior)', () => {
  const d = fakeDeps({ lanBind: false, tunnelActive: false })
  const c = fakeContext({})
  assert.equal(isLocalRequest(c, d), true)
})

// isLocalOrAuthenticated (agent actions: runs/config/skills, which execute on the host)
// must inherit the SAME tunnel-safety guarantee as isLocalRequest — a request that
// actually traversed the Cloud Launch tunnel looks loopback too, so it must never take
// the bare loopback shortcut; it has to fall through to the requireApiKey check just
// like any other non-loopback caller (ADR-152).

test('isLocalOrAuthenticated: THE CRITICAL CASE — a tunneled request that looks loopback must NOT bypass without a key', () => {
  const d = fakeDeps({ lanBind: false, tunnelActive: true, requireApiKey: false })
  const c = fakeContext({ 'cf-ray': 'abc123-DEL' })
  assert.equal(isLocalOrAuthenticated(c, d), false)
})

test('isLocalOrAuthenticated: a tunneled request is allowed once requireApiKey is on (lanAuth already verified the key)', () => {
  const d = fakeDeps({ lanBind: false, tunnelActive: true, requireApiKey: true })
  const c = fakeContext({ 'cf-ray': 'abc123-DEL' })
  assert.equal(isLocalOrAuthenticated(c, d), true)
})

test('isLocalOrAuthenticated: tunnel active but THIS request carries no Cloudflare headers is still local', () => {
  const d = fakeDeps({ lanBind: false, tunnelActive: true, requireApiKey: false })
  const c = fakeContext({})
  assert.equal(isLocalOrAuthenticated(c, d), true)
})

test('isLocalOrAuthenticated: loopback-only bind with no tunnel at all is still always local (unchanged behavior)', () => {
  const d = fakeDeps({ lanBind: false, tunnelActive: false })
  const c = fakeContext({})
  assert.equal(isLocalOrAuthenticated(c, d), true)
})

test('isLocalOrAuthenticated: LAN-exposed, non-loopback, no tunnel, requireApiKey off — remote still blocked', () => {
  const d = fakeDeps({ lanBind: true, tunnelActive: false, requireApiKey: false })
  const c = fakeContext({})
  assert.equal(isLocalOrAuthenticated(c, d), false)
})

test('isLocalOrAuthenticated: LAN-exposed, non-loopback, no tunnel, requireApiKey on — remote allowed (authenticated by lanAuth)', () => {
  const d = fakeDeps({ lanBind: true, tunnelActive: false, requireApiKey: true })
  const c = fakeContext({})
  assert.equal(isLocalOrAuthenticated(c, d), true)
})

test('provisionTunnelApiKey: stores a fresh key and returns its full (unhashed) value', () => {
  const pushed: Array<{ id: string; name: string; hash: string }> = []
  const d = {
    store: {
      update: (fn: (cfg: { apiKeys: typeof pushed }) => void) => {
        const cfg = { apiKeys: pushed }
        fn(cfg)
      },
    },
  } as unknown as Deps
  const full = provisionTunnelApiKey(d)
  assert.match(full, /^tllm-[0-9A-Za-z]{40}$/)
  assert.equal(pushed.length, 1)
  assert.match(pushed[0].name, /^tunnel-/)
  assert.notEqual(pushed[0].hash, full) // only the hash is persisted, never the raw key
})

// codeAuth (Code-specific gate, independent of the global requireApiKey toggle): Chat can
// stay open on the LAN with no key, but Code must always require one from a non-host device —
// see auth.ts's own doc comment on codeAuth for the rationale (real bash/edit/write access).

const RAW_KEY = 'tllm-testkeyABCDEFGHIJKLMNOPQRSTUVWXYZ01'
const RAW_KEY_HASH = createHash('sha256').update(RAW_KEY).digest('hex')

function fakeDepsWithKeys(overrides: { lanBind?: boolean; tunnelActive?: boolean; hasKey?: boolean }): Deps {
  const apiKeys = overrides.hasKey
    ? [{ id: 'k1', name: 'test', hash: RAW_KEY_HASH, prefix: RAW_KEY.slice(0, 12), createdAt: '', lastUsedAt: null }]
    : []
  return {
    store: {
      snapshot: () => ({
        daemon: { lanBind: overrides.lanBind ?? false, requireApiKey: false },
        apiKeys,
      } as unknown as ReturnType<Deps['store']['snapshot']>),
      update: (fn: (cfg: { apiKeys: typeof apiKeys }) => void) => fn({ apiKeys }),
    },
    tunnel: overrides.tunnelActive !== undefined ? ({ active: () => overrides.tunnelActive } as Deps['tunnel']) : undefined,
  } as unknown as Deps
}

test('verifyPresentedKey: no header at all → false', () => {
  const d = fakeDepsWithKeys({ hasKey: true })
  const c = fakeContext({})
  assert.equal(verifyPresentedKey(c, d), false)
})

test('verifyPresentedKey: a key that matches no stored hash → false', () => {
  const d = fakeDepsWithKeys({ hasKey: true })
  const c = fakeContext({ 'x-turbollm-auth': 'tllm-wrongwrongwrongwrongwrongwrongwrongwr' })
  assert.equal(verifyPresentedKey(c, d), false)
})

test('verifyPresentedKey: the correct key (via X-TurboLLM-Auth) → true', () => {
  const d = fakeDepsWithKeys({ hasKey: true })
  const c = fakeContext({ 'x-turbollm-auth': RAW_KEY })
  assert.equal(verifyPresentedKey(c, d), true)
})

test('verifyPresentedKey: the correct key via Authorization: Bearer → true', () => {
  const d = fakeDepsWithKeys({ hasKey: true })
  const c = fakeContext({ authorization: `Bearer ${RAW_KEY}` })
  assert.equal(verifyPresentedKey(c, d), true)
})

/** A minimal fake Hono context for exercising codeAuth end-to-end as real middleware —
 *  everything lanAuth's own test suite above stops short of (it only tests the pure
 *  bypassesAuth/isLocalRequest logic). Records what json() returned, if anything; each test
 *  tracks whether its own next() ran via its own local closure variable. */
function fakeMiddlewareContext(headers: Record<string, string | undefined>): { c: Context; jsonResult: () => { body: unknown; status: number } | undefined } {
  let jsonResult: { body: unknown; status: number } | undefined
  const c = {
    req: { header: (name: string) => headers[name.toLowerCase()] },
    json: (body: unknown, status: number) => { jsonResult = { body, status }; return jsonResult },
  } as unknown as Context
  return { c, jsonResult: () => jsonResult }
}

test('codeAuth: a request local to the host (loopback-only bind) always passes, no key needed', async () => {
  const d = fakeDepsWithKeys({ lanBind: false, hasKey: false })
  const { c, jsonResult } = fakeMiddlewareContext({})
  let called = false
  await codeAuth(d)(c, async () => { called = true })
  assert.equal(called, true)
  assert.equal(jsonResult(), undefined)
})

test('codeAuth: LAN-exposed + no key presented at all → 401, even though Chat-style access would be open', async () => {
  const d = fakeDepsWithKeys({ lanBind: true, hasKey: true })
  const { c, jsonResult } = fakeMiddlewareContext({})
  let called = false
  await codeAuth(d)(c, async () => { called = true })
  assert.equal(called, false)
  assert.equal(jsonResult()?.status, 401)
})

test('codeAuth: LAN-exposed + a valid key presented → passes', async () => {
  const d = fakeDepsWithKeys({ lanBind: true, hasKey: true })
  const { c, jsonResult } = fakeMiddlewareContext({ 'x-turbollm-auth': RAW_KEY })
  let called = false
  await codeAuth(d)(c, async () => { called = true })
  assert.equal(called, true)
  assert.equal(jsonResult(), undefined)
})

test('codeAuth: LAN-exposed + a WRONG key presented → still 401', async () => {
  const d = fakeDepsWithKeys({ lanBind: true, hasKey: true })
  const { c, jsonResult } = fakeMiddlewareContext({ 'x-turbollm-auth': 'tllm-nope0000000000000000000000000000000' })
  let called = false
  await codeAuth(d)(c, async () => { called = true })
  assert.equal(called, false)
  assert.equal(jsonResult()?.status, 401)
})

test('codeAuth: a genuinely tunneled request is never treated as local, even with lanBind off', async () => {
  const d = fakeDepsWithKeys({ lanBind: false, tunnelActive: true, hasKey: true })
  const { c, jsonResult } = fakeMiddlewareContext({ 'cf-ray': 'abc123-DEL' })
  let called = false
  await codeAuth(d)(c, async () => { called = true })
  assert.equal(called, false)
  assert.equal(jsonResult()?.status, 401)
})
