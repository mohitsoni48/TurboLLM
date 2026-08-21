// Turbo Link's `config:read` / `config:write` routes, exercised END TO END.
//
// The point of this suite, over config-scope.test.ts, is R2: it proves the ROUTES are
// wired to the scope, not merely that the scope exists. A façade that computed a perfect
// allowlist and then merged the raw body anyway would pass config-scope.test.ts in full.
// So every escalation vector is driven here a SECOND time — through HTTP, through
// linkAuth, through requireCapability, and into a REAL ConfigStore backed by a real file
// in a temp dir, which is then re-read from disk to confirm nothing landed.
//
// The store is deliberately real rather than a stub: "a legal write applies and persists"
// is a claim about config.json, and a fake store cannot falsify it. The temp dir is per
// test and removed afterwards — this suite never touches ~/.turbollm.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Hono } from 'hono'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { registerLinkApi } from './link-routes'
import { ConfigStore, type ApiKey, type Config } from '../config/config'
import type { Deps } from '../deps'

function key(raw: string, caps?: string[]): ApiKey {
  return {
    id: randomUUID(),
    name: 'laptop',
    hash: createHash('sha256').update(raw).digest('hex'),
    prefix: raw.slice(0, 12),
    createdAt: 'c',
    lastUsedAt: null,
    ...(caps ? { grant: { capabilities: caps as never } } : {}),
  }
}

interface Harness {
  d: Deps
  store: ConfigStore
  /** The config as it exists ON DISK right now — never the in-memory copy. */
  onDisk: () => Config
}

/** The on-disk config as a comparable string, with `apiKeys[].lastUsedAt` normalised out.
 *  `resolveKey` legitimately stamps that field on every authenticated request and persists
 *  it — it is auth doing its job, not the patch landing — so a raw whole-file comparison
 *  would flag every refused request as a mutation. Everything else stays in the
 *  comparison, deliberately: the invariant is "a refused patch changes NOTHING else". */
function stable(cfg: Config): string {
  const copy = structuredClone(cfg)
  for (const k of copy.apiKeys) k.lastUsedAt = null
  return JSON.stringify(copy)
}

function mkDeps(t: { after: (fn: () => void) => void }, keys: ApiKey[], seed?: (c: Config) => void): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'tl-link-config-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const path = join(dir, 'config.json')
  const store = ConfigStore.load(path)
  store.update((c) => {
    c.apiKeys = keys
    c.daemon.lanBind = false
    c.daemon.requireApiKey = true
    c.modelDefaults.ctx = 4096
    c.gateway.keepN = 1
    seed?.(c)
  })
  const d = { version: '1.11.2', store } as unknown as Deps
  return { d, store, onDisk: () => JSON.parse(readFileSync(path, 'utf8')) as Config }
}

function app(d: Deps) {
  const a = new Hono()
  registerLinkApi(a, d)
  return a
}

function get(a: Hono, path: string, token: string) {
  return a.request(path, { headers: { 'X-TurboLLM-Auth': token } })
}

function patch(a: Hono, token: string, body: unknown) {
  return a.request('/api/link/v1/config', {
    method: 'PATCH',
    headers: { 'X-TurboLLM-Auth': token, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

// ── read ────────────────────────────────────────────────────────────────────────────────

test('read is 403 without config:read — the ROUTE is gated, not just the scope', async (t) => {
  const h = mkDeps(t, [key('tllm-a', ['models:use', 'config:write'])])
  const res = await get(app(h.d), '/api/link/v1/config', 'tllm-a')
  assert.equal(res.status, 403)
  const body = await res.json() as { error: { code: string; capability: string } }
  assert.equal(body.error.code, 'forbidden')
  assert.equal(body.error.capability, 'config:read')
})

test('read is 401 with no token at all', async (t) => {
  const h = mkDeps(t, [key('tllm-a', ['config:read'])])
  const res = await app(h.d).request('/api/link/v1/config')
  assert.equal(res.status, 401)
})

test('read returns the scoped projection, and no host secret or path', async (t) => {
  const h = mkDeps(t, [key('tllm-a', ['config:read'])], (c) => {
    c.modelDirs = [process.platform === 'win32' ? 'D:\\models' : '/home/dev/models']
    c.primaryModelDir = c.modelDirs[0]!
    c.hf = { token: 'hf-supersecret' }
    c.tools = { search: { provider: 'tavily', tavilyApiKey: 'tv-supersecret' } }
    c.daemon.authToken = 'tllm-authtoken-secret'
    c.daemon.theme = 'dark'
    c.telemetry = { level: 'full', machineId: 'telemetry-machine-id' }
  })
  const res = await get(app(h.d), '/api/link/v1/config', 'tllm-a')
  assert.equal(res.status, 200)
  const raw = await res.text()

  // What it DOES carry.
  const body = JSON.parse(raw) as { config: Record<string, Record<string, unknown>> }
  assert.equal(body.config.modelDefaults!.ctx, 4096)
  assert.equal(body.config.gateway!.keepN, 1)
  assert.equal(body.config.daemon!.theme, 'dark')

  // What it must never carry. The last three are the class of leak this feature has
  // already been burned by three times: host filesystem detail crossing the façade.
  for (const leak of [
    'hf-supersecret', 'tv-supersecret', 'tllm-authtoken-secret', 'telemetry-machine-id',
    'apiKeys', 'links', 'telemetry', 'hash', 'authToken', 'lanBind', 'requireApiKey',
    'modelDirs', 'primaryModelDir', 'binPath', 'toolchainDirs', 'gatePath',
    'models', 'engines',
  ]) {
    assert.ok(!raw.includes(leak), `config:read leaked ${leak}: ${raw}`)
  }
})

// ── write: the gate ─────────────────────────────────────────────────────────────────────

test('write is 403 without config:write, and changes nothing', async (t) => {
  const h = mkDeps(t, [key('tllm-a', ['config:read'])])
  const res = await patch(app(h.d), 'tllm-a', { patch: { 'modelDefaults.ctx': 8192 } })
  assert.equal(res.status, 403)
  const body = await res.json() as { error: { code: string; capability: string } }
  assert.equal(body.error.capability, 'config:write')
  assert.equal(h.onDisk().modelDefaults.ctx, 4096)
})

// ── write: the escalation vectors, through the composed path ────────────────────────────

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
    path: 'daemon.requireApiKey',
  },
  { name: "flip the owner's telemetry consent", patch: { 'telemetry.level': 'full' }, path: 'telemetry.level' },
  {
    name: 'point the host at a machine the owner never approved',
    patch: { links: [{ id: 'x', name: 'x', baseUrl: 'https://attacker.example', token: 'tllm-evil' }] },
    path: 'links',
  },
]

for (const v of VECTORS) {
  test(`ESCALATION (route) — config:write must not let a peer ${v.name}`, async (t) => {
    const h = mkDeps(t, [key('tllm-a', ['config:write'])])
    const before = stable(h.onDisk())

    const res = await patch(app(h.d), 'tllm-a', { patch: v.patch })
    assert.equal(res.status, 403, `expected 403, got ${res.status}`)
    const body = await res.json() as { error: { code: string; rejected: string[]; message: string } }
    assert.equal(body.error.code, 'forbidden')
    // Named, not merely refused: the peer greys its controls off the handshake, so a
    // refusal here means the two ends disagree and the peer must be able to say which key.
    assert.ok(body.error.rejected.includes(v.path), `rejected must name ${v.path}: ${JSON.stringify(body)}`)
    assert.ok(body.error.message.includes(v.path))

    // Nothing landed — asserted against the FILE, not the in-memory store.
    assert.equal(stable(h.onDisk()), before)
  })
}

test('a mixed patch — one legal path, one apiKeys path — applies NEITHER', async (t) => {
  // The bisection defence, at the route: a partial apply would let a peer map the
  // allowlist by probing pairs while still landing the permitted half of every probe.
  const h = mkDeps(t, [key('tllm-a', ['config:write'])])
  const res = await patch(app(h.d), 'tllm-a', {
    patch: { 'modelDefaults.ctx': 8192, apiKeys: [] },
  })
  assert.equal(res.status, 403)
  const body = await res.json() as { error: { rejected: string[] } }
  assert.deepEqual(body.error.rejected, ['apiKeys'])
  assert.equal(h.onDisk().modelDefaults.ctx, 4096, 'the legal half must not have landed')
  assert.equal(h.onDisk().apiKeys.length, 1)
})

test('a prototype-pollution path is refused and pollutes nothing', async (t) => {
  const h = mkDeps(t, [key('tllm-a', ['config:write'])])
  const res = await patch(app(h.d), 'tllm-a', { patch: { '__proto__.polluted': 'yes' } })
  assert.equal(res.status, 403)
  assert.equal(({} as Record<string, unknown>).polluted, undefined)
})

// ── write: the happy path ───────────────────────────────────────────────────────────────

test('a legal write applies and PERSISTS to config.json', async (t) => {
  const h = mkDeps(t, [key('tllm-a', ['config:write', 'config:read'])])
  const res = await patch(app(h.d), 'tllm-a', {
    patch: { 'modelDefaults.ctx': 8192, 'gateway.keepN': 3, 'daemon.theme': 'light' },
  })
  assert.equal(res.status, 200)
  const body = await res.json() as { ok: boolean; applied: string[]; config: Record<string, Record<string, unknown>> }
  assert.equal(body.ok, true)
  assert.deepEqual([...body.applied].sort(), ['daemon.theme', 'gateway.keepN', 'modelDefaults.ctx'])

  // Persisted — read back from the FILE, so this is a claim about config.json.
  const disk = h.onDisk()
  assert.equal(disk.modelDefaults.ctx, 8192)
  assert.equal(disk.gateway.keepN, 3)
  assert.equal(disk.daemon.theme, 'light')
  // Untouched neighbours, including the ones an over-broad block write would have wiped.
  assert.equal(disk.daemon.lanBind, false)
  assert.equal(disk.daemon.requireApiKey, true)
  assert.equal(disk.apiKeys.length, 1)

  // The echoed config is the same scoped projection the read route returns.
  assert.equal(body.config.modelDefaults!.ctx, 8192)
  assert.ok(!JSON.stringify(body.config).includes('lanBind'))
})

test('an out-of-range value on an allowed path is 400, not 403, and applies nothing', async (t) => {
  const h = mkDeps(t, [key('tllm-a', ['config:write'])])
  const res = await patch(app(h.d), 'tllm-a', { patch: { 'gateway.keepN': 9999 } })
  assert.equal(res.status, 400)
  const body = await res.json() as { error: { code: string; invalid: string[] } }
  assert.equal(body.error.code, 'invalid_value')
  assert.deepEqual(body.error.invalid, ['gateway.keepN'])
  assert.equal(h.onDisk().gateway.keepN, 1)
})

test('a malformed body is a clean 400', async (t) => {
  const h = mkDeps(t, [key('tllm-a', ['config:write'])])
  const a = app(h.d)
  for (const body of [{}, { patch: null }, { patch: 'apiKeys' }, { patch: [] }]) {
    const res = await patch(a, 'tllm-a', body)
    assert.equal(res.status, 400, `${JSON.stringify(body)} should be 400`)
    const parsed = await res.json() as { error: { code: string } }
    assert.equal(parsed.error.code, 'invalid_request')
  }
  const noBody = await a.request('/api/link/v1/config', {
    method: 'PATCH',
    headers: { 'X-TurboLLM-Auth': 'tllm-a', 'content-type': 'application/json' },
  })
  assert.equal(noBody.status, 400)
})

test('a legacy key with NO grant still reaches both routes (existing keys are full-access)', async (t) => {
  const h = mkDeps(t, [key('tllm-legacy')])
  const a = app(h.d)
  assert.equal((await get(a, '/api/link/v1/config', 'tllm-legacy')).status, 200)
  const res = await patch(a, 'tllm-legacy', { patch: { 'modelDefaults.ctx': 8192 } })
  assert.equal(res.status, 200)
  assert.equal(h.onDisk().modelDefaults.ctx, 8192)
})

test('a legacy full-access key is STILL bound by the path allowlist', async (t) => {
  // The allowlist is a property of the CAPABILITY, not of the grant: `config:write` never
  // meant "write anything", so an ungranted (legacy, full-access) key gets exactly the
  // same scope. Otherwise the safest keys to hand out would be the oldest ones.
  const h = mkDeps(t, [key('tllm-legacy')])
  const res = await patch(app(h.d), 'tllm-legacy', { patch: { 'daemon.lanBind': true } })
  assert.equal(res.status, 403)
  assert.equal(h.onDisk().daemon.lanBind, false)
})
