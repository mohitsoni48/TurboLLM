import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ModelRouter } from './model-router'
import type { LinkRecord } from '../link/types'

type Row = { key: string; name: string }

/** Builds a router whose LOCAL catalog is `local`, whose linked machines are `links`,
 *  and whose currently-loaded local model is `loaded`. `remoteModels` maps a link id to
 *  the model keys that machine exposes. */
function mkRouter(opts: {
  local: Row[]
  loaded?: string
  links?: LinkRecord[]
  remoteModels?: Record<string, Row[]>
  autoSwap?: boolean
}) {
  const links = opts.links ?? []
  const remoteModels = opts.remoteModels ?? {}
  const cfg = { gateway: { autoSwap: opts.autoSwap ?? true }, links, modelDefaults: {} }

  const manager = {
    target: () => (opts.loaded ? 'http://127.0.0.1:8080' : null),
    status: () => (opts.loaded
      ? { state: 'running', model: { key: opts.loaded } }
      : { state: 'stopped', model: null }),
    touch: () => {},
  }
  const scanner = { list: () => ({ models: opts.local }), get: () => undefined }
  const catalog = {
    linkByName: (n: string) => links.find((l) => l.name.toLowerCase() === n.toLowerCase()),
    modelOn: (linkId: string, key: string) => (remoteModels[linkId] ?? []).find((m) => m.key === key),
  }

  // NOTE: the real constructor is (store, registry, manager, scanner, comfy, catalog?) —
  // the brief's 4-arg call predates the `registry` parameter. The catalog is still
  // injected by property assignment (as the brief specifies) so this suite needs no
  // network; the trailing constructor parameter is what production wiring uses.
  const r = new ModelRouter(
    { snapshot: () => cfg, update: (fn: (c: never) => void) => fn(cfg as never) } as never,
    {} as never,
    manager as never,
    scanner as never,
    undefined,
    undefined,
  )
  ;(r as unknown as { catalog: unknown }).catalog = catalog
  return r
}

const link = (over: Partial<LinkRecord> = {}): LinkRecord => ({
  id: 'l1', name: 'workstation', baseUrl: 'https://ws.trycloudflare.com', token: 'tllm-secret',
  machineId: 'm1', grantedCapabilities: ['models:use'], linkApiVersion: 1,
  status: 'online', lastSeenAt: null, lastError: null, ...over,
})

// ── Invariant 5. Each of these is a way the EXISTING helpful behaviour would silently
// answer a remote request from a LOCAL model. Every one must be a 503.

test('a qualified id for an OFFLINE link is a 503 — never the currently loaded local model', async () => {
  // The nightmare case. workstation is down; route() would otherwise fall back to
  // manager.target() and return a plausible answer from entirely the wrong model.
  const r = mkRouter({
    local: [{ key: 'local-llama', name: 'local-llama' }],
    loaded: 'local-llama',
    links: [link({ status: 'unreachable' })],
    remoteModels: { l1: [{ key: 'Qwen3-35B', name: 'Qwen3-35B' }] },
  })
  const res = await r.route('workstation/Qwen3-35B')
  assert.equal('status' in res && res.status, 503)
  assert.match((res as { message: string }).message, /workstation/)
  assert.match((res as { message: string }).message, /unreachable/)
})

test('a qualified id for a link whose model list lacks it is a 503, not a fuzzy local match', async () => {
  // resolveEntry ends in a SUBSTRING match, so a local model merely named 'Qwen3'
  // would otherwise win.
  const r = mkRouter({
    local: [{ key: 'Qwen3', name: 'Qwen3' }],
    loaded: 'Qwen3',
    links: [link()],
    remoteModels: { l1: [] },
  })
  const res = await r.route('workstation/Qwen3')
  assert.equal('status' in res && res.status, 503)
  assert.match((res as { message: string }).message, /does not have/)
})

test('a qualified id is a 503 even when autoSwap is OFF', async () => {
  // route() early-returns the loaded model when autoSwap is off, BEFORE resolveEntry is
  // reached at all — so the remote branch must run before that early return.
  const r = mkRouter({
    local: [{ key: 'local-llama', name: 'local-llama' }],
    loaded: 'local-llama',
    links: [link({ status: 'unreachable' })],
    autoSwap: false,
  })
  const res = await r.route('workstation/Qwen3-35B')
  assert.equal('status' in res && res.status, 503)
})

test('an offline link with NO local model loaded is still a 503 naming the machine', async () => {
  const r = mkRouter({ local: [], links: [link({ status: 'revoked' })] })
  const res = await r.route('workstation/Qwen3-35B')
  assert.equal('status' in res && res.status, 503)
  assert.match((res as { message: string }).message, /workstation/)
})

// ── Local behaviour must be completely unchanged.

test('a bare local id still resolves locally, including via the fuzzy match', async () => {
  const r = mkRouter({
    local: [{ key: 'Qwen3-35B-Instruct', name: 'Qwen3-35B-Instruct' }],
    loaded: 'Qwen3-35B-Instruct',
    links: [link()],
  })
  const res = await r.route('qwen3-35b')
  assert.equal('target' in res, true)
  assert.equal((res as { remote?: unknown }).remote, undefined)
})

test('a LOCAL model key containing a slash still resolves locally when links exist', async () => {
  // 'unsloth/Qwen3-GGUF' parses as qualified, but 'unsloth' is not a linked machine —
  // the machine lookup must MISS and fall through to local resolution, not 503.
  const r = mkRouter({
    local: [{ key: 'unsloth/Qwen3-GGUF', name: 'Qwen3-GGUF' }],
    loaded: 'unsloth/Qwen3-GGUF',
    links: [link()],
  })
  const res = await r.route('unsloth/Qwen3-GGUF')
  assert.equal('target' in res, true)
  assert.equal((res as { remote?: unknown }).remote, undefined)
})

// ── The happy path.

test('a resolved remote model returns the host base URL and the link token', async () => {
  const r = mkRouter({
    local: [],
    links: [link()],
    remoteModels: { l1: [{ key: 'Qwen3-35B', name: 'Qwen3-35B' }] },
  })
  const res = await r.route('workstation/Qwen3-35B')
  assert.ok('target' in res)
  const rem = (res as { remote: { linkId: string; baseUrl: string; token: string; modelKey: string } }).remote
  assert.equal(rem.linkId, 'l1')
  assert.equal(rem.baseUrl, 'https://ws.trycloudflare.com')
  assert.equal(rem.token, 'tllm-secret')
  assert.equal(rem.modelKey, 'Qwen3-35B')
})

test('machine matching is case-insensitive', async () => {
  const r = mkRouter({
    local: [],
    links: [link()],
    remoteModels: { l1: [{ key: 'Qwen3-35B', name: 'Qwen3-35B' }] },
  })
  assert.ok('target' in (await r.route('WORKSTATION/Qwen3-35B')))
})

test('model matching is EXACT — a remote model is never resolved by substring', async () => {
  // The host-side mirror of the same hazard: 'Qwen3' must not resolve to 'Qwen3-35B'.
  const r = mkRouter({
    local: [],
    links: [link()],
    remoteModels: { l1: [{ key: 'Qwen3-35B', name: 'Qwen3-35B' }] },
  })
  const res = await r.route('workstation/Qwen3')
  assert.equal('status' in res && res.status, 503)
})


// ── autoSwap OFF is the single most dangerous configuration for the remote guard, because
// route()'s early return hands back the CURRENTLY LOADED local model without ever reaching
// resolveEntry. One case above already pins the offline link there; these pin the rest of
// the branch in the same configuration, in both directions — the guard must neither leak a
// local answer nor silently disable federation.

test('autoSwap OFF: a qualified id whose machine LACKS that model is a 503, not the loaded local model', async () => {
  const r = mkRouter({
    local: [{ key: 'local-llama', name: 'local-llama' }],
    loaded: 'local-llama',
    links: [link()],                                   // online, reachable
    remoteModels: { l1: [{ key: 'Qwen3-35B', name: 'Qwen3-35B' }] },
    autoSwap: false,
  })
  const res = await r.route('workstation/Gemma-27B')
  assert.equal('status' in res && res.status, 503)
})

test('autoSwap OFF: exact model matching still holds for a remote id', async () => {
  const r = mkRouter({
    local: [{ key: 'local-llama', name: 'local-llama' }],
    loaded: 'local-llama',
    links: [link()],
    remoteModels: { l1: [{ key: 'Qwen3-35B', name: 'Qwen3-35B' }] },
    autoSwap: false,
  })
  const res = await r.route('workstation/Qwen3')
  assert.equal('status' in res && res.status, 503)
})

test('autoSwap OFF: a RESOLVABLE qualified id still routes to the remote host, not the local fallback', async () => {
  // The other direction of the same guard. autoSwap is a LOCAL swap policy; reading it as
  // "federation off" would turn every remote request into a silently-local answer, which is
  // precisely what invariant 5 forbids.
  const r = mkRouter({
    local: [{ key: 'local-llama', name: 'local-llama' }],
    loaded: 'local-llama',
    links: [link()],
    remoteModels: { l1: [{ key: 'Qwen3-35B', name: 'Qwen3-35B' }] },
    autoSwap: false,
  })
  const res = await r.route('workstation/Qwen3-35B')
  assert.ok('target' in res, 'must not early-return the loaded local model')
  const rem = (res as { remote: { baseUrl: string; modelKey: string } }).remote
  assert.equal(rem.baseUrl, 'https://ws.trycloudflare.com')
  assert.equal(rem.modelKey, 'Qwen3-35B')
})

test('autoSwap OFF: a BARE local id keeps its long-standing fallback to the loaded model', async () => {
  // Explicitly NOT changed. The fallback exists so unrecognised aliases don't break
  // clients; only QUALIFIED ids fail loudly. Pinned so the guard above cannot creep.
  const r = mkRouter({
    local: [{ key: 'local-llama', name: 'local-llama' }],
    loaded: 'local-llama',
    links: [link()],
    autoSwap: false,
  })
  assert.ok('target' in (await r.route('something-nobody-has')))
})
