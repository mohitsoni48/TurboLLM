// Model load preset HTTP routes (ADR-353). A preset is a named saved load-config for one
// modelKey — many per model, versus the single per-(model, engine) profile in modelProfiles.
// Conversations never see presets; the pin (cfg.lastPresetId) is what getModelProfile consults.
//   GET    /api/v1/models/:key/presets            — list ModelPreset[], newest updatedAt first
//   POST   /api/v1/models/:key/presets            — create {name, engineId?, profile} → 201
//   PUT    /api/v1/models/:key/presets/:id        — update {name?, engineId?, profile?}
//   DELETE /api/v1/models/:key/presets/:id        — delete (keeps the array; clears a matching pin)
//   POST   /api/v1/models/:key/presets/:id/apply  — set the pin, return the preset
import type { Hono } from 'hono'
import { randomUUID } from 'node:crypto'
import type { Deps } from '../deps'
import { MODEL_PRESET_CAP, type ModelPreset } from '../config/config'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function err(c: any, status: number, code: string, message: string) {
  return c.json({ error: { code, message } }, status)
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function body<T>(c: any): Promise<T> {
  try { return (await c.req.json()) as T } catch { return {} as T }
}

// A preset's profile is a LoadProfile — a plain JSON object. Arrays and scalars are rejected
// at the boundary: a scalar profile would pass normalize() (profile is `unknown`) and then
// break every consumer that indexes into it.
function isProfileObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

export function registerPresetRoutes(app: Hono, d: Deps): void {
  app.get('/api/v1/models/:key/presets', (c) => {
    const key = decodeURIComponent(c.req.param('key'))
    const presets = d.store.snapshot().modelPresets[key] ?? []
    return c.json([...presets].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0)))
  })

  app.post('/api/v1/models/:key/presets', async (c) => {
    const key = decodeURIComponent(c.req.param('key'))
    const b = await body<Partial<ModelPreset>>(c)
    if (typeof b.name !== 'string' || !b.name.trim()) {
      return err(c, 400, 'invalid_config_value', 'name is required.')
    }
    if (!isProfileObject(b.profile)) {
      return err(c, 400, 'invalid_config_value', 'profile must be a JSON object.')
    }
    // Cap pre-check BEFORE store.update — update() runs validate() and throws, so a cap
    // breach here would be a 500. The cap is PER MODEL.
    if ((d.store.snapshot().modelPresets[key] ?? []).length >= MODEL_PRESET_CAP) {
      return err(c, 400, 'too_many_presets', `Preset limit reached (${MODEL_PRESET_CAP}).`)
    }
    const preset: ModelPreset = {
      id: randomUUID(),
      name: b.name.trim(),
      engineId: typeof b.engineId === 'string' ? b.engineId : '',
      profile: b.profile,
      updatedAt: new Date().toISOString(),
      origin: 'manual',
    }
    d.store.update((cfg) => {
      ;(cfg.modelPresets[key] ??= []).push(preset)
    })
    return c.json(preset, 201)
  })

  app.put('/api/v1/models/:key/presets/:id', async (c) => {
    const key = decodeURIComponent(c.req.param('key'))
    const id = c.req.param('id')
    const existing = (d.store.snapshot().modelPresets[key] ?? []).find((p) => p.id === id)
    if (!existing) return err(c, 404, 'not_found', 'Preset not found.')
    const b = await body<Partial<ModelPreset>>(c)
    if (b.name !== undefined && (typeof b.name !== 'string' || !b.name.trim())) {
      return err(c, 400, 'invalid_config_value', 'name must be a non-empty string.')
    }
    if (b.profile !== undefined && !isProfileObject(b.profile)) {
      return err(c, 400, 'invalid_config_value', 'profile must be a JSON object.')
    }
    d.store.update((cfg) => {
      const arr = cfg.modelPresets[key] ?? []
      const i = arr.findIndex((p) => p.id === id)
      if (i === -1) return
      const p = arr[i]
      if (b.name !== undefined) p.name = b.name.trim()
      if (typeof b.engineId === 'string') p.engineId = b.engineId
      // Only a profile change re-stamps updatedAt (it drives dropdown order AND retention
      // pruning — re-stamping on a rename would protect an old preset from pruning).
      if (b.profile !== undefined) {
        p.profile = b.profile
        p.updatedAt = new Date().toISOString()
      }
    })
    return c.json((d.store.snapshot().modelPresets[key] ?? []).find((p) => p.id === id)!)
  })

  app.delete('/api/v1/models/:key/presets/:id', (c) => {
    const key = decodeURIComponent(c.req.param('key'))
    const id = c.req.param('id')
    const existing = (d.store.snapshot().modelPresets[key] ?? []).find((p) => p.id === id)
    if (!existing) return err(c, 404, 'not_found', 'Preset not found.')
    d.store.update((cfg) => {
      // Filter and assign back — never `delete cfg.modelPresets[key]`: a present-but-empty
      // array means "already seeded" to the seed migration, and dropping the key would
      // resurrect every deleted preset on the next load.
      cfg.modelPresets[key] = (cfg.modelPresets[key] ?? []).filter((p) => p.id !== id)
      if (cfg.lastPresetId?.[key] === id) delete cfg.lastPresetId[key]
    })
    return c.json({ ok: true })
  })

  app.post('/api/v1/models/:key/presets/:id/apply', (c) => {
    const key = decodeURIComponent(c.req.param('key'))
    const id = c.req.param('id')
    const existing = (d.store.snapshot().modelPresets[key] ?? []).find((p) => p.id === id)
    if (!existing) return err(c, 404, 'not_found', 'Preset not found.')
    d.store.update((cfg) => {
      ;(cfg.lastPresetId ??= {})[key] = id
    })
    return c.json(existing)
  })
}
