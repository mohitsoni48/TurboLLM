import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LinkManager } from './link-manager'
import { Emitter } from '../telemetry/emit'
import { readQueue } from '../telemetry/queue'
import type { Deps } from '../deps'
import type { LinkRecord } from './types'

function mkDeps(links: LinkRecord[], telemetry?: Emitter): { d: Deps; cfg: { links: LinkRecord[] } } {
  const cfg = { links, daemon: {}, apiKeys: [] }
  const d = {
    store: { snapshot: () => cfg, update: (fn: (c: never) => void) => fn(cfg as never) },
    ...(telemetry ? { telemetry } : {}),
  } as unknown as Deps
  return { d, cfg: cfg as { links: LinkRecord[] } }
}

/** Real `Emitter` over a temp data dir, at `anon` consent. */
function mkTelemetry(): { telemetry: Emitter; dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'turbollm-link-manager-telemetry-'))
  const cfg = { telemetry: { level: 'anon', machineId: '44444444-4444-4444-4444-444444444444' } }
  const telemetry = new Emitter({
    dataDir: dir,
    store: { snapshot: () => cfg, update: (fn: (c: typeof cfg) => void) => fn(cfg) } as never,
    version: '1.11.2',
    os: 'win32/x64',
  })
  return { telemetry, dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

const rec = (over: Partial<LinkRecord> = {}): LinkRecord => ({
  id: 'l1', name: 'workstation', baseUrl: 'http://h:6996', token: 'tllm-x',
  machineId: null, grantedCapabilities: [], linkApiVersion: null,
  status: 'unknown', lastSeenAt: null, lastError: null, ...over,
})

const helloOk = async () => new Response(JSON.stringify({
  machineId: 'm1', machineName: 'workstation', appVersion: '1.11.2',
  linkApiVersions: [1], capabilities: ['models:use'],
}), { status: 200, headers: { 'content-type': 'application/json' } })

test('a successful probe records capabilities, version, machineId and lastSeenAt', async () => {
  const { d, cfg } = mkDeps([rec()])
  const m = new LinkManager(d, { fetchImpl: helloOk })
  await m.probeOnce('l1')
  const l = cfg.links[0]
  assert.equal(l.status, 'online')
  assert.deepEqual(l.grantedCapabilities, ['models:use'])
  assert.equal(l.linkApiVersion, 1)
  assert.equal(l.machineId, 'm1')
  assert.ok(l.lastSeenAt)
})

test('capabilities re-reported on a later probe overwrite the cached set', async () => {
  // Spec §5.4: a token edited on the host self-heals on the peer within one poll,
  // instead of staying stale until the user relinks.
  const { d, cfg } = mkDeps([rec({ grantedCapabilities: ['models:use'], status: 'online' })])
  const m = new LinkManager(d, {
    fetchImpl: async () => new Response(JSON.stringify({
      machineId: 'm1', machineName: 'w', appVersion: '1', linkApiVersions: [1],
      capabilities: ['models:use', 'models:load'],
    }), { status: 200, headers: { 'content-type': 'application/json' } }),
  })
  await m.probeOnce('l1')
  assert.deepEqual(cfg.links[0].grantedCapabilities, ['models:use', 'models:load'])
})

test('a 401 marks revoked and does not wipe the record', async () => {
  const { d, cfg } = mkDeps([rec({ status: 'online', grantedCapabilities: ['models:use'] })])
  const m = new LinkManager(d, { fetchImpl: async () => new Response('', { status: 401 }) })
  await m.probeOnce('l1')
  assert.equal(cfg.links[0].status, 'revoked')
  assert.equal(cfg.links[0].baseUrl, 'http://h:6996')
  assert.equal(cfg.links[0].token, 'tllm-x')
})

test('a machineId change is flagged in lastError rather than silently adopted', async () => {
  // The URL was reused by a different box. Silently adopting it would let a stranger's
  // daemon inherit a link the user believes points at their workstation.
  const { d, cfg } = mkDeps([rec({ machineId: 'OLD', status: 'online' })])
  const m = new LinkManager(d, { fetchImpl: helloOk })
  await m.probeOnce('l1')
  assert.match(cfg.links[0].lastError ?? '', /different machine/i)
})

test('probeOnce on an unknown id resolves quietly instead of throwing', async () => {
  const { d } = mkDeps([])
  const m = new LinkManager(d, { fetchImpl: helloOk })
  await m.probeOnce('nope')
})

// ── Design invariant 3: isolation.
test('one hanging link never blocks the others', async () => {
  const { d, cfg } = mkDeps([
    rec({ id: 'slow', baseUrl: 'http://slow:6996' }),
    rec({ id: 'fast', baseUrl: 'http://fast:6996' }),
  ])
  const m = new LinkManager(d, {
    fetchImpl: (u) => String(u).includes('slow')
      ? new Promise((_r, rej) => setTimeout(() => rej(new Error('t')), 50)) as Promise<Response>
      : helloOk(),
  })
  await m.probeAll()
  assert.equal(cfg.links.find((l) => l.id === 'fast')!.status, 'online')
  assert.equal(cfg.links.find((l) => l.id === 'slow')!.status, 'unreachable')
})

test('probeAll never rejects, even when every link fails', async () => {
  const { d } = mkDeps([rec({ id: 'a' }), rec({ id: 'b' })])
  const m = new LinkManager(d, { fetchImpl: async () => { throw new Error('boom') } })
  await m.probeAll()
})

// ── Telemetry (Task 11): link_status_changed ────────────────────────────────

test('probeOnce emits link_status_changed when the status actually transitions', async () => {
  const { telemetry, dir, cleanup } = mkTelemetry()
  try {
    const { d } = mkDeps([rec({ status: 'unknown' })], telemetry)
    const m = new LinkManager(d, { fetchImpl: helloOk })
    await m.probeOnce('l1')
    const events = readQueue(dir).map((q) => q.event as { event: string; payload?: Record<string, unknown> })
    const changed = events.filter((e) => e.event === 'link_status_changed')
    assert.equal(changed.length, 1)
    assert.deepEqual(changed[0].payload, { from: 'unknown', to: 'online' })
  } finally {
    cleanup()
  }
})

test('probeOnce emits nothing when the status is unchanged', async () => {
  const { telemetry, dir, cleanup } = mkTelemetry()
  try {
    const { d } = mkDeps([rec({ status: 'online' })], telemetry)
    const m = new LinkManager(d, { fetchImpl: helloOk })
    await m.probeOnce('l1')
    const events = readQueue(dir).map((q) => q.event as { event: string })
    assert.deepEqual(events.filter((e) => e.event === 'link_status_changed'), [])
  } finally {
    cleanup()
  }
})

test('probeOnce link_status_changed payload never carries a token, url, or hostname', async () => {
  const { telemetry, dir, cleanup } = mkTelemetry()
  try {
    const { d } = mkDeps([rec({
      id: 'l1', status: 'unknown', baseUrl: 'https://secret-host.trycloudflare.com', token: 'tllm-super-secret',
    })], telemetry)
    const m = new LinkManager(d, { fetchImpl: helloOk })
    await m.probeOnce('l1')
    const text = JSON.stringify(readQueue(dir))
    assert.ok(!text.includes('tllm-'))
    assert.ok(!text.includes('secret-host'))
    assert.ok(!/https?:\/\//.test(text))
  } finally {
    cleanup()
  }
})

test('probeOnce with no telemetry deps is a no-op, not a crash', async () => {
  const { d, cfg } = mkDeps([rec({ status: 'unknown' })])
  const m = new LinkManager(d, { fetchImpl: helloOk })
  await m.probeOnce('l1')
  assert.equal(cfg.links[0].status, 'online')
})

// ── Persist only on a real change (ADR-376 final review, I-4) ────────────────────────
//
// `ConfigStore.update` has no dirty check: it structuredClones the whole config,
// validates it, then writeFileSync + renameSync the ENTIRE file, synchronously, on the
// thread that also serves inference. `applyProbeResult` stamps a fresh `lastSeenAt` on
// every successful probe, so an unconditional update meant one full config rewrite per
// link per 15 s tick — ~5.8k/day with one link, ~17k with three — none of them carrying
// new information. Phase 2 routes every inference request and every progress poll through
// this same path, so a steady-state poll must not touch the disk at all.

/** Same double as `mkDeps`, plus a count of how many times the config was actually
 *  written. That count IS the assertion here — the record contents are covered above. */
function mkCountingDeps(links: LinkRecord[]): { d: Deps; cfg: { links: LinkRecord[] }; writes: () => number } {
  const cfg = { links, daemon: {}, apiKeys: [] }
  let writes = 0
  const d = {
    store: {
      snapshot: () => cfg,
      update: (fn: (c: never) => void) => { writes++; fn(cfg as never) },
    },
  } as unknown as Deps
  return { d, cfg: cfg as { links: LinkRecord[] }, writes: () => writes }
}

test('a steady-state poll that changes nothing does NOT rewrite config.json', async () => {
  const { d, writes } = mkCountingDeps([rec()])
  const m = new LinkManager(d, { fetchImpl: helloOk })
  await m.probeOnce('l1')          // first probe: unknown → online, a real change
  assert.equal(writes(), 1)
  await m.probeOnce('l1')          // identical result
  await m.probeOnce('l1')
  await m.probeOnce('l1')
  assert.equal(writes(), 1, 'unchanged polls must not touch the disk')
})

test('the heartbeat of an unchanged link is still tracked, just in memory', async () => {
  const { d, cfg } = mkCountingDeps([rec()])
  const m = new LinkManager(d, { fetchImpl: helloOk })
  await m.probeOnce('l1')
  const persisted = cfg.links[0].lastSeenAt
  await new Promise((r) => setTimeout(r, 5))
  await m.probeOnce('l1')
  // Nothing durable changed, so the stored record is untouched...
  assert.equal(cfg.links[0].lastSeenAt, persisted)
  // ...but the manager still knows when the host was last reachable.
  assert.ok(m.lastSeenAt('l1')! >= persisted!)
})

test('a status change still persists immediately', async () => {
  let up = true
  const fetchImpl = async () => {
    if (!up) throw new TypeError('fetch failed')
    return helloOk()
  }
  const { d, cfg, writes } = mkCountingDeps([rec()])
  const m = new LinkManager(d, { fetchImpl: fetchImpl as typeof fetch })
  await m.probeOnce('l1')
  assert.equal(writes(), 1)
  await m.probeOnce('l1')
  assert.equal(writes(), 1)
  up = false
  await m.probeOnce('l1')
  assert.equal(writes(), 2, 'a transition to unreachable must reach the disk')
  assert.equal(cfg.links[0].status, 'unreachable')
})

test('a machineId change persists immediately — the anti-hijack latch is never in-memory-only', async () => {
  let machine = 'm1'
  const fetchImpl = (async () => new Response(JSON.stringify({
    machineId: machine, machineName: 'workstation', appVersion: '1.11.2',
    linkApiVersions: [1], capabilities: ['models:use'],
  }), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch
  const { d, cfg, writes } = mkCountingDeps([rec()])
  const m = new LinkManager(d, { fetchImpl })
  await m.probeOnce('l1')
  const before = writes()
  machine = 'stranger'
  await m.probeOnce('l1')
  assert.equal(writes(), before + 1)
  assert.equal(cfg.links[0].machineIdChanged, true)
})

test('a capability change persists immediately, so a host-side edit self-heals on disk', async () => {
  let caps = ['models:use']
  const fetchImpl = (async () => new Response(JSON.stringify({
    machineId: 'm1', machineName: 'workstation', appVersion: '1.11.2',
    linkApiVersions: [1], capabilities: caps,
  }), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch
  const { d, cfg, writes } = mkCountingDeps([rec()])
  const m = new LinkManager(d, { fetchImpl })
  await m.probeOnce('l1')
  const before = writes()
  caps = ['models:use', 'models:load']
  await m.probeOnce('l1')
  assert.equal(writes(), before + 1)
  assert.deepEqual(cfg.links[0].grantedCapabilities, ['models:use', 'models:load'])
})
