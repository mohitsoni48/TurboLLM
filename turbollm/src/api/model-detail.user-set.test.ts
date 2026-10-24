// GET /api/v1/models/:key gives the model dialog what it needs to send and save only what the user set: `saved`, the
// fields of the saved profile that are the user's (profile.ts userSetProfile, an earlier build's whole draft read field
// by field), and `autoProfile`, what the model loads with when nothing is set, which a preset applied in the dialog is
// merged onto. Without them the dialog could only resend its whole draft, the built-in defaults included.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Hono } from 'hono'
import { registerApi } from './routes'
import { defaultConfig, setModelProfile, type Config } from '../config/config'
import type { Deps } from '../deps'
import { automaticProfile, type LoadProfile } from '../models/profile'
import type { ModelEntry } from '../models/scanner'
import { getSysInfo } from '../sysinfo/sysinfo'

const M: ModelEntry = {
  key: 'm|q4|1', name: 'm', path: '/models/m.gguf', dir: '/models', format: 'gguf',
  sizeBytes: 4_000_000_000, sizeLabel: '4 GB', arch: 'llama', quant: 'Q4_K_M',
  nativeCtx: 32768, blockCount: 32, headCountKv: 8, headDim: 0, moe: false, expertCount: 0,
  nextnLayers: 0, vision: false, audio: false, mmprojPath: null, mmprojSizeBytes: 0, hasChatTemplate: true, reasoningEffort: false, embedding: false,
  incomplete: false, parseError: null, loaded: false, hasProfile: false,
  benchTps: null, mtime: '',
}

function app(cfg: Config): Hono {
  const a = new Hono()
  registerApi(a, {
    version: 'test',
    store: { snapshot: () => cfg, update: (fn: (c: Config) => void) => fn(cfg) },
    scanner: { get: (k: string) => (k === M.key ? M : undefined) },
    registry: { active: () => ({ id: 'e1', kind: 'llama-server' }), layaEngine: () => undefined },
    manager: { status: () => ({ state: 'stopped', model: null }) },
    modelRouter: { loadedModelKeys: () => new Set<string>() },
    db: { lastGenTpsByModel: () => new Map<string, number>() },
    downloads: { provenance: () => [] },
  } as unknown as Deps)
  return a
}

async function detail(cfg: Config): Promise<{ profile: LoadProfile; saved: Partial<LoadProfile>; autoProfile: LoadProfile }> {
  const res = await app(cfg).request(`/api/v1/models/${encodeURIComponent(M.key)}?engine=e1`)
  assert.equal(res.status, 200)
  return await res.json() as { profile: LoadProfile; saved: Partial<LoadProfile>; autoProfile: LoadProfile }
}

test('GET /models/:key: the automatic profile, and nothing saved for a model without a profile', async () => {
  const d = await detail(defaultConfig())
  assert.deepEqual(d.saved, {})
  assert.deepEqual(d.autoProfile, JSON.parse(JSON.stringify(automaticProfile(M, getSysInfo(), defaultConfig().modelDefaults))))
})

test('GET /models/:key: an earlier build\'s whole draft comes back as the fields that are the user\'s', async () => {
  const cfg = defaultConfig()
  const auto = automaticProfile(M, getSysInfo(), cfg.modelDefaults)
  setModelProfile(cfg, M.key, 'e1', { ...auto, flashAttn: 'off', sampling: { ...auto.sampling, temp: 0.3 } })
  const d = await detail(cfg)
  assert.deepEqual(d.saved, { flashAttn: 'off', sampling: { temp: 0.3 } })
  assert.equal(d.profile.flashAttn, 'off')
  assert.equal(d.profile.ctx, auto.ctx)
})

test('GET /models/:key: a profile of only what the user set comes back as it is, without the marker', async () => {
  const cfg = defaultConfig()
  setModelProfile(cfg, M.key, 'e1', { ctx: 8192, userSetOnly: true })
  const d = await detail(cfg)
  assert.deepEqual(d.saved, { ctx: 8192 })
  assert.equal('userSetOnly' in d.profile, false)
})

test('GET /models/:key: a .litertlm\'s resting sampling is its bundle\'s own, which the model and thread dialogs show', async () => {
  // The dialogs showed llama.cpp's 0.8 / 0.95 / 40 for every LiteRT-LM model, labelled the model's defaults.
  const litert = { ...M, format: 'litertlm', arch: 'litertlm', path: '/models/q.litertlm', sampler: { topK: 20, topP: 0.95, temp: 0.6 } } as ModelEntry
  const a = new Hono()
  const cfg = defaultConfig()
  registerApi(a, {
    version: 'test',
    store: { snapshot: () => cfg, update: (fn: (c: Config) => void) => fn(cfg) },
    scanner: { get: (k: string) => (k === M.key ? litert : undefined) },
    registry: { active: () => ({ id: 'e1', kind: 'litert-lm' }), layaEngine: () => undefined },
    manager: { status: () => ({ state: 'stopped', model: null }) },
    modelRouter: { loadedModelKeys: () => new Set<string>() },
    db: { lastGenTpsByModel: () => new Map<string, number>() },
    downloads: { provenance: () => [] },
  } as unknown as Deps)
  const res = await a.request(`/api/v1/models/${encodeURIComponent(M.key)}?engine=e1`)
  const d = await res.json() as { profile: LoadProfile; autoProfile: LoadProfile }
  for (const s of [d.profile.sampling, d.autoProfile.sampling]) assert.deepEqual({ temp: s.temp, topP: s.topP, topK: s.topK }, { temp: 0.6, topP: 0.95, topK: 20 })
})
