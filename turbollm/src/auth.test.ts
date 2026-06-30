import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bypassesAuth, isLocalRequest, isLocalOrAuthenticated, provisionTunnelApiKey } from './auth'
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
