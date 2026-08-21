import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  WRITABLE_CONFIG_PATHS,
  isWritablePath,
  scrubConfigForRead,
  applyScopedPatch,
} from './config-scope'
import { CONFIG_BOUNDS } from '../config/config-bounds'

/** The scope's leaf validators, reached through the public surface: `scrubConfigForRead`
 *  emits a leaf only when its validator passes, so a single-leaf config round-tripped
 *  through it is exactly `validator(value)`. Testing through the public API rather than
 *  exporting the internal record keeps the module's surface as small as its contract. */
const WRITABLE_LEAVES_FOR_TEST: Record<string, (v: unknown) => boolean> = Object.fromEntries(
  Object.keys(CONFIG_BOUNDS).map((path) => [path, (v: unknown) => {
    const segs = path.split('.')
    const cfg = { [segs[0]!]: { [segs[1]!]: v } }
    const out = scrubConfigForRead(cfg as never) as Record<string, Record<string, unknown>>
    return out[segs[0]!]?.[segs[1]!] !== undefined
  }]),
)

// ── Every one of these is a full compromise of the IAM model if it succeeds.
test('apiKeys is never writable — a peer must not mint itself a full-access token', () => {
  assert.equal(isWritablePath('apiKeys'), false)
  assert.equal(isWritablePath('apiKeys.0.grant'), false)
  assert.equal(isWritablePath('apiKeys.0.grant.capabilities'), false)
})

test('links is never writable — a peer must not point the host at a machine the owner never approved', () => {
  assert.equal(isWritablePath('links'), false)
})

test('daemon network settings are never writable — a peer must not open the host to the LAN', () => {
  assert.equal(isWritablePath('daemon.lanBind'), false)
  assert.equal(isWritablePath('daemon.requireApiKey'), false)
  assert.equal(isWritablePath('daemon.port'), false)
})

test('telemetry consent is never writable — it is the owner\'s decision, not the peer\'s', () => {
  assert.equal(isWritablePath('telemetry'), false)
  assert.equal(isWritablePath('telemetry.level'), false)
})

test('a path that merely starts with a writable prefix is not thereby writable', () => {
  // Guards a prefix-matching implementation: 'modelDefaultsEvil' must not pass because
  // 'modelDefaults' does.
  assert.equal(isWritablePath('modelDefaults'), true)
  assert.equal(isWritablePath('modelDefaultsEvil'), false)
})

test('prototype-pollution keys are rejected outright', () => {
  assert.equal(isWritablePath('__proto__'), false)
  assert.equal(isWritablePath('constructor.prototype.x'), false)
  assert.equal(isWritablePath('modelDefaults.__proto__.x'), false)
})

test('applyScopedPatch applies only allowed paths and REPORTS the rejected ones', () => {
  const cfg = { modelDefaults: { ctx: 4096 }, apiKeys: [], daemon: { lanBind: false } } as never
  const r = applyScopedPatch(cfg, { 'modelDefaults.ctx': 8192, 'daemon.lanBind': true })
  assert.equal(r.ok, false)
  if (!r.ok) assert.deepEqual(r.rejected, ['daemon.lanBind'])
})

test('a patch containing ANY rejected path applies NOTHING — it is all-or-nothing', () => {
  // A partial apply would let an attacker learn which paths pass by bisection while
  // still landing the allowed half. Atomic rejection is both safer and clearer.
  const cfg = { modelDefaults: { ctx: 4096 }, daemon: { lanBind: false } } as never
  applyScopedPatch(cfg, { 'modelDefaults.ctx': 8192, 'daemon.lanBind': true })
  assert.equal((cfg as unknown as { modelDefaults: { ctx: number } }).modelDefaults.ctx, 4096)
})

test('scrubConfigForRead removes every secret, not just apiKeys', () => {
  const cfg = {
    apiKeys: [{ hash: 'h' }],
    links: [{ token: 'tllm-secret' }],
    tools: { tavily: { apiKey: 'tv-secret' } },
    search: { tavilyApiKey: 'tv2', kagiApiKey: 'kg' },
    modelDefaults: { ctx: 4096 },
  } as never
  const out = JSON.stringify(scrubConfigForRead(cfg))
  assert.ok(!out.includes('tllm-secret'))
  assert.ok(!out.includes('tv-secret'))
  assert.ok(!out.includes('tv2'))
  assert.ok(!out.includes('kg'))
  assert.ok(!out.includes('hash'))
  assert.ok(out.includes('4096'))
})

// ── The rest of the deny surface, and the host-filesystem rule. ─────────────────────────

/** The six escalation vectors, driven through `applyScopedPatch` — the function a route
 *  actually calls. Asserting only `isWritablePath` here would be the "verified one layer
 *  while the composed path stayed broken" mistake: a naive `applyScopedPatch` that never
 *  consults the predicate passes an isWritablePath-only suite while every attack lands. */
const VECTORS: Array<{ name: string; patch: Record<string, unknown>; path: string }> = [
  {
    name: 'mint itself a full-access token by appending to apiKeys',
    patch: { apiKeys: [{ id: 'evil', name: 'evil', hash: 'h', prefix: 'tllm-evil', createdAt: 'c', lastUsedAt: null }] },
    path: 'apiKeys',
  },
  {
    name: "edit its own key's grant to full access",
    patch: { 'apiKeys.0.grant.capabilities': ['models:use', 'config:write'] },
    path: 'apiKeys.0.grant.capabilities',
  },
  { name: 'delete every other key, locking the owner out', patch: { apiKeys: [] }, path: 'apiKeys' },
  {
    name: 'open the host to the network',
    patch: { 'daemon.lanBind': true, 'daemon.requireApiKey': false },
    path: 'daemon.lanBind',
  },
  { name: "flip the owner's telemetry consent", patch: { 'telemetry.level': 'full' }, path: 'telemetry.level' },
  {
    name: 'point the host at a machine the owner never approved',
    patch: { links: [{ id: 'x', baseUrl: 'https://attacker.example', token: 'tllm-evil' }] },
    path: 'links',
  },
]

for (const v of VECTORS) {
  test(`ESCALATION — a peer must not ${v.name}`, () => {
    const cfg = {
      apiKeys: [{ id: 'owner', name: 'owner', hash: 'h', prefix: 'p', createdAt: 'c', lastUsedAt: null }],
      links: [],
      telemetry: { level: 'off', machineId: 'm' },
      daemon: { lanBind: false, requireApiKey: true, port: 6996 },
      modelDefaults: { ctx: 4096 },
    }
    const before = JSON.stringify(cfg)
    const r = applyScopedPatch(cfg as never, v.patch)
    assert.equal(r.ok, false, 'the patch must be refused')
    if (!r.ok) assert.ok(r.rejected.includes(v.path), `rejected must name ${v.path}, got ${JSON.stringify(r.rejected)}`)
    assert.equal(JSON.stringify(cfg), before, 'the config must be byte-for-byte unchanged')
  })
}

test('the six escalation vectors are denied by name', () => {
  // 1. mint a token   2. edit own grant   3. delete other keys — all live under apiKeys
  assert.equal(isWritablePath('apiKeys'), false)
  // 4. open the host to the network
  assert.equal(isWritablePath('daemon.lanBind'), false)
  assert.equal(isWritablePath('daemon.requireApiKey'), false)
  // 5. change a consent decision that is not the peer's to make
  assert.equal(isWritablePath('telemetry'), false)
  // 6. point the host at a machine the owner never approved
  assert.equal(isWritablePath('links'), false)
})

test('engine, filesystem and credential paths are never writable', () => {
  for (const p of [
    'engines', 'engines.0.binPath', 'activeEngineId', 'customEngineSources',
    'modelDirs', 'primaryModelDir', 'build.toolchainDirs', 'devModel',
    'devModel.modelPath', 'hf', 'hf.token', 'tools', 'tools.search.tavilyApiKey',
    'mcp', 'mcp.servers', 'code', 'code.agentsMdProjectCandidates',
    'agents', 'customAgents', 'cloudDeploy', 'comfyui', 'comfyui.gatePath',
    'daemon', 'daemon.authToken', 'daemon.machineId', 'daemon.experimental',
    'version', 'onboarding', 'benchResults', 'modelProfiles', 'modelPresets',
  ]) {
    assert.equal(isWritablePath(p), false, `${p} must not be writable`)
  }
})

test('the allowlist is CLOSED — nothing outside it is writable', () => {
  // The point of the allowlist: a field added to the Config schema tomorrow is not
  // writable until someone deliberately adds it here and writes a test.
  assert.equal(isWritablePath('someFieldAddedNextQuarter'), false)
  assert.equal(isWritablePath('modelDefaults.someLeafAddedNextQuarter'), false)
  for (const p of WRITABLE_CONFIG_PATHS) assert.equal(isWritablePath(p), true)
})

test('malformed paths are rejected, not coerced', () => {
  assert.equal(isWritablePath(''), false)
  assert.equal(isWritablePath('.'), false)
  assert.equal(isWritablePath('modelDefaults.'), false)
  assert.equal(isWritablePath('.modelDefaults'), false)
  assert.equal(isWritablePath('modelDefaults..ctx'), false)
  assert.equal(isWritablePath('modelDefaults.ctx '), false)
  assert.equal(isWritablePath(' modelDefaults.ctx'), false)
  assert.equal(isWritablePath('MODELDEFAULTS.ctx'), false)
  assert.equal(isWritablePath(undefined as never), false)
  assert.equal(isWritablePath(42 as never), false)
})

test('scrubConfigForRead emits no host filesystem detail', () => {
  const cfg = {
    modelDirs: ['D:\\models', '/home/dev/models'],
    primaryModelDir: 'D:\\models',
    engines: [{ id: 'e1', binPath: 'D:\\engines\\llama-server.exe' }],
    build: { toolchainDirs: ['D:\\cuda\\bin'] },
    devModel: { modelPath: '/home/dev/m.gguf', extraArgs: [], label: 'x' },
    comfyui: { enabled: true, gatePath: 'D:\\comfy\\custom_nodes', url: '', reverseGate: false, cachePersist: false },
    daemon: { theme: 'dark', authToken: 'tllm-authtoken', machineId: 'mid', lanBind: true, port: 6996 },
    modelDefaults: { ctx: 4096, ngl: 99 },
    gateway: { autoSwap: true, keepN: 2 },
  } as never
  const out = JSON.stringify(scrubConfigForRead(cfg))
  for (const leak of [
    'D:\\\\models', '/home/dev/models', 'llama-server', 'D:\\\\cuda', 'custom_nodes',
    'tllm-authtoken', 'binPath', 'modelDirs', 'primaryModelDir', 'toolchainDirs',
    'gatePath', 'modelPath', 'authToken', 'machineId', 'lanBind',
  ]) {
    assert.ok(!out.includes(leak), `scrubbed config leaked ${leak}: ${out}`)
  }
  assert.ok(out.includes('4096'))
})

test('scrubConfigForRead is an allowlist projection — an unknown future field never appears', () => {
  const cfg = { modelDefaults: { ctx: 4096 }, brandNewSecretField: 'leak-me' } as never
  const out = JSON.stringify(scrubConfigForRead(cfg))
  assert.ok(!out.includes('leak-me'))
  assert.ok(!out.includes('brandNewSecretField'))
})

test('scrubConfigForRead survives a config missing whole blocks', () => {
  const out = scrubConfigForRead({} as never)
  assert.equal(typeof out, 'object')
  assert.notEqual(out, null)
})

test('applyScopedPatch applies a wholly-legal patch and reports what it applied', () => {
  const cfg = { modelDefaults: { ctx: 4096, ngl: 0 }, gateway: { autoSwap: false, keepN: 1 } } as never
  const r = applyScopedPatch(cfg, { 'modelDefaults.ctx': 8192, 'gateway.keepN': 3 })
  assert.equal(r.ok, true)
  if (r.ok) assert.deepEqual([...r.applied].sort(), ['gateway.keepN', 'modelDefaults.ctx'])
  const c = cfg as unknown as { modelDefaults: { ctx: number; ngl: number }; gateway: { keepN: number } }
  assert.equal(c.modelDefaults.ctx, 8192)
  assert.equal(c.modelDefaults.ngl, 0)
  assert.equal(c.gateway.keepN, 3)
})

test('applyScopedPatch reports EVERY rejected path, not just the first', () => {
  const cfg = { modelDefaults: { ctx: 1 } } as never
  const r = applyScopedPatch(cfg, { apiKeys: [], links: [], telemetry: { level: 'off' } })
  assert.equal(r.ok, false)
  if (!r.ok) assert.deepEqual([...r.rejected].sort(), ['apiKeys', 'links', 'telemetry'])
})

test('applyScopedPatch never pollutes Object.prototype — not via the path, not via the value', () => {
  const cfg = { modelDefaults: { ctx: 1 } } as never
  applyScopedPatch(cfg, { '__proto__.polluted': 'yes' })
  applyScopedPatch(cfg, { 'constructor.prototype.polluted': 'yes' })
  // A JSON body CAN carry an own `__proto__` key; assigning such an object into the
  // config would persist it to disk and hand the next JSON.parse a pollution primitive.
  applyScopedPatch(cfg, { modelDefaults: JSON.parse('{"ctx":1,"__proto__":{"polluted":"yes"}}') })
  assert.equal(({} as Record<string, unknown>).polluted, undefined)
  assert.equal((Object.prototype as unknown as Record<string, unknown>).polluted, undefined)
})

test('applyScopedPatch rejects an out-of-range value on an ALLOWED path, and applies nothing', () => {
  const cfg = { gateway: { autoSwap: true, keepN: 2 } } as never
  const r = applyScopedPatch(cfg, { 'gateway.keepN': 9999 })
  assert.equal(r.ok, false)
  if (!r.ok) assert.deepEqual(r.invalid, ['gateway.keepN'])
  assert.equal((cfg as unknown as { gateway: { keepN: number } }).gateway.keepN, 2)
})

test('applyScopedPatch rejects a wrong-typed value on an allowed path', () => {
  const cfg = { modelDefaults: { ctx: 4096 }, gateway: { autoSwap: true, keepN: 1 } } as never
  for (const patch of [
    { 'modelDefaults.ctx': 'lots' },
    { 'modelDefaults.ctx': -1 },
    { 'gateway.autoSwap': 'yes' },
    { 'daemon.theme': { evil: true } },
    { modelDefaults: { ctx: 4096, lanBind: true } }, // unknown key inside a block object
  ]) {
    const r = applyScopedPatch(cfg, patch as Record<string, unknown>)
    assert.equal(r.ok, false, `${JSON.stringify(patch)} should not apply`)
  }
  assert.equal((cfg as unknown as { modelDefaults: { ctx: number } }).modelDefaults.ctx, 4096)
})

test('an empty patch is a no-op success, not an error', () => {
  const cfg = { modelDefaults: { ctx: 4096 } } as never
  const r = applyScopedPatch(cfg, {})
  assert.equal(r.ok, true)
  if (r.ok) assert.deepEqual(r.applied, [])
})

test('a non-object patch is rejected rather than crashing', () => {
  const cfg = { modelDefaults: { ctx: 4096 } } as never
  for (const bad of [null, undefined, 'apiKeys', 42, []]) {
    const r = applyScopedPatch(cfg, bad as never)
    assert.equal(r.ok, false)
  }
})

// ── Review finding 1: the remote bounds must never be WIDER than the owner's own. ────────

test('the remote leaf bounds are the LOCAL bounds — one shared table, no second copy', () => {
  // The anti-drift property is structural: config-scope.ts imports CONFIG_BOUNDS rather
  // than restating the numbers, and api/routes.ts validates against the same table. This
  // walks the table and proves the remote validator tracks it exactly at every edge.
  for (const [path, b] of Object.entries(CONFIG_BOUNDS)) {
    const leaf = WRITABLE_LEAVES_FOR_TEST[path]
    assert.ok(leaf, `${path} should be a writable leaf`)
    assert.equal(leaf!(b.min), true, `${path}: min ${b.min} must be accepted`)
    assert.equal(leaf!(b.min - 1), false, `${path}: below min must be rejected`)
    if (Number.isSafeInteger(b.max)) {
      assert.equal(leaf!(b.max), true, `${path}: max ${b.max} must be accepted`)
      if (b.max < Number.MAX_SAFE_INTEGER) {
        assert.equal(leaf!(b.max + 1), false, `${path}: above max must be rejected`)
      }
    }
    // Strictly narrower than the local route, which coerces: no strings, no fractions.
    assert.equal(leaf!(String(b.min)), false, `${path}: a numeric string must be rejected`)
    assert.equal(leaf!(b.min + 0.5), false, `${path}: a fraction must be rejected`)
  }
})

test('the exact values the review flagged are now refused', () => {
  const cfg = { modelDefaults: { ctx: 4096, ngl: 50 } } as never
  // ctx below the owner's 256 floor.
  let r = applyScopedPatch(cfg, { 'modelDefaults.ctx': 128 })
  assert.equal(r.ok, false)
  if (!r.ok) assert.deepEqual(r.invalid, ['modelDefaults.ctx'])
  // ngl = -1, which is NOT an "all layers" sentinel in this codebase — profileToArgs gates
  // on `p.ngl > 0`, so it means no offload, and the owner's 0-99 control cannot represent
  // it in order to correct it.
  r = applyScopedPatch(cfg, { 'modelDefaults.ngl': -1 })
  assert.equal(r.ok, false)
  if (!r.ok) assert.deepEqual(r.invalid, ['modelDefaults.ngl'])
  r = applyScopedPatch(cfg, { 'modelDefaults.ngl': 100 })
  assert.equal(r.ok, false)
  // Untouched throughout.
  const c = cfg as unknown as { modelDefaults: { ctx: number; ngl: number } }
  assert.equal(c.modelDefaults.ctx, 4096)
  assert.equal(c.modelDefaults.ngl, 50)
})

test('a block write cannot smuggle an out-of-range leaf past the leaf bounds', () => {
  const cfg = { modelDefaults: { ctx: 4096, ngl: 50 } } as never
  const r = applyScopedPatch(cfg, { modelDefaults: { ctx: 1, ngl: -1 } })
  assert.equal(r.ok, false)
  assert.equal((cfg as unknown as { modelDefaults: { ctx: number } }).modelDefaults.ctx, 4096)
})

// ── Review finding 3: say plainly what a block write does. ───────────────────────────────

test('a block write REPLACES the block, dropping optional leaves', () => {
  // Documented, not accidental: `maxTokens`/`imageMaxTokens` are themselves writable
  // leaves, so a block write that omits them reaches nothing a direct leaf write could not.
  const cfg = { modelDefaults: { ctx: 4096, ngl: 50, maxTokens: 512, imageMaxTokens: 256 } } as never
  const r = applyScopedPatch(cfg, { modelDefaults: { ctx: 8192, ngl: 60 } })
  assert.equal(r.ok, true)
  assert.deepEqual((cfg as unknown as { modelDefaults: unknown }).modelDefaults, { ctx: 8192, ngl: 60 })
  // …and a block write still may not DROP a required key.
  assert.equal(applyScopedPatch(cfg, { modelDefaults: { ctx: 8192 } }).ok, false)
})

// ── Review finding 7: allowlist lookups can never hit a prototype member. ────────────────

test('a prototype-member name is rejected, never resolved against the allowlist', () => {
  for (const p of ['toString', 'valueOf', 'hasOwnProperty', 'constructor']) {
    assert.equal(isWritablePath(p), false)
    const cfg = { modelDefaults: { ctx: 4096 } } as never
    const r = applyScopedPatch(cfg, { [p]: 1 })
    assert.equal(r.ok, false, `${p} must be refused, not crash`)
    if (!r.ok) assert.deepEqual(r.rejected, [p])
  }
})
