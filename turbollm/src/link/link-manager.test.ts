import { test } from 'node:test'
import assert from 'node:assert/strict'
import { LinkManager } from './link-manager'
import type { Deps } from '../deps'
import type { LinkRecord } from './types'

function mkDeps(links: LinkRecord[]): { d: Deps; cfg: { links: LinkRecord[] } } {
  const cfg = { links, daemon: {}, apiKeys: [] }
  const d = {
    store: { snapshot: () => cfg, update: (fn: (c: never) => void) => fn(cfg as never) },
  } as unknown as Deps
  return { d, cfg: cfg as { links: LinkRecord[] } }
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
