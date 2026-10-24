// Model load preset HTTP routes (ADR-353). A preset is a named saved load-config for one
// modelKey — many per model, versus the single per-(model, engine) profile in modelProfiles.
// Conversations never see presets; the pin (cfg.lastPresetId) is what getModelProfile consults.
//   GET    /api/v1/models/:key/presets            — { presets, pinnedId }, newest updatedAt first
//   POST   /api/v1/models/:key/presets            — create {name, engineId?, profile} → 201
//   PUT    /api/v1/models/:key/presets/:id        — update {name?, engineId?, profile?}
//   DELETE /api/v1/models/:key/presets/:id        — delete (keeps the array; clears a matching pin)
//   POST   /api/v1/models/:key/presets/:id/apply  — set the pin, return the preset
import type { Hono } from 'hono'
import { randomUUID } from 'node:crypto'
import type { Deps } from '../deps'
import { MODEL_PRESET_CAP, ownEntry, type ModelPreset } from '../config/config'
import { isUserSetOnly, launchFieldsRefusal, loadsWithNow, validateLoadProfileFields } from './profile-validate'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function err(c: any, status: number, code: string, message: string) {
  return c.json({ error: { code, message } }, status)
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function body<T>(c: any): Promise<T> {
  try { return (await c.req.json()) as T } catch { return {} as T }
}

export function registerPresetRoutes(app: Hono, d: Deps): void {
  // Every handler: `c.req.param()` is already percent-decoded (decoding again broke keys with
  // '%'), and the key is request input, so the config maps are read through `ownEntry` — a key
  // like `constructor` would otherwise index Object itself (see config.ts).
  //
  // A preset's flags and files reach the engine's command line once it is pinned, so creating,
  // editing and pinning one are held to /engine/start's rule (launchFieldsRefusal): values of the
  // caller's own need a key. What it is compared with is what the model loads with now on the
  // preset's engine (the dialog's Save as… sends that draft), or the preset's own when editing.
  //
  // Returns the pin alongside the list. The client cannot know which preset is active otherwise,
  // and a dropdown that always opens on "No preset applied" is actively misleading: the pin is
  // what getModelProfile serves on the next load.
  app.get('/api/v1/models/:key/presets', (c) => {
    const key = c.req.param('key')
    const snap = d.store.snapshot()
    const presets = ownEntry(snap.modelPresets, key) ?? []
    return c.json({
      presets: [...presets].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0)),
      pinnedId: ownEntry(snap.lastPresetId, key) ?? null,
    })
  })

  app.post('/api/v1/models/:key/presets', async (c) => {
    const key = c.req.param('key')
    // Same model-existence guard PUT /models/:key/profile applies — without it any client can
    // write presets under unlimited arbitrary keys into config.json.
    if (!d.scanner.get(key)) return err(c, 404, 'no_such_model', 'No model with that key.')
    const b = await body<Partial<ModelPreset>>(c)
    if (typeof b.name !== 'string' || !b.name.trim()) {
      return err(c, 400, 'invalid_config_value', 'name is required.')
    }
    // Field-level validation, not just shape: a pinned preset's profile is handed verbatim to
    // profileToArgs, so a bad field here becomes a broken engine command line and every later
    // load of that model fails. Must match PUT /models/:key/profile exactly.
    const invalid = validateLoadProfileFields(b.profile, { requireCtx: !isUserSetOnly(b.profile) })
    if (invalid) return err(c, 400, 'invalid_config_value', invalid)
    const launchRefused = launchFieldsRefusal(c, d, b.profile, loadsWithNow(d, key, typeof b.engineId === 'string' ? b.engineId : ''))
    if (launchRefused) return launchRefused
    // Cap pre-check BEFORE store.update — update() runs validate() and throws, so a cap
    // breach here would be a 500. The cap is PER MODEL.
    if ((ownEntry(d.store.snapshot().modelPresets, key) ?? []).length >= MODEL_PRESET_CAP) {
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
      ;(ownEntry(cfg.modelPresets, key) ?? (cfg.modelPresets[key] = [])).push(preset)
    })
    return c.json(preset, 201)
  })

  app.put('/api/v1/models/:key/presets/:id', async (c) => {
    const key = c.req.param('key')
    const id = c.req.param('id')
    const existing = (ownEntry(d.store.snapshot().modelPresets, key) ?? []).find((p) => p.id === id)
    if (!existing) return err(c, 404, 'not_found', 'Preset not found.')
    const b = await body<Partial<ModelPreset>>(c)
    if (b.name !== undefined && (typeof b.name !== 'string' || !b.name.trim())) {
      return err(c, 400, 'invalid_config_value', 'name must be a non-empty string.')
    }
    if (b.profile !== undefined) {
      // Partial-tolerant: a patch may omit ctx, but whatever it DOES set must be loadable.
      const bad = validateLoadProfileFields(b.profile, { requireCtx: false })
      if (bad) return err(c, 400, 'invalid_config_value', bad)
      const launchRefused = launchFieldsRefusal(c, d, b.profile, () => existing.profile)
      if (launchRefused) return launchRefused
    }
    // The 404 pre-check above happened before `await body()` yielded the event loop, so a delete
    // for this same id can land in between. Track whether the preset still existed at write time
    // and 404 rather than returning 200 with an empty body (which makes the client's res.json()
    // throw a parse error instead of showing "Preset not found").
    let stillExists = false
    d.store.update((cfg) => {
      const arr = ownEntry(cfg.modelPresets, key) ?? []
      const i = arr.findIndex((p) => p.id === id)
      if (i === -1) return
      stillExists = true
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
    if (!stillExists) return err(c, 404, 'not_found', 'Preset not found.')
    const updated = (ownEntry(d.store.snapshot().modelPresets, key) ?? []).find((p) => p.id === id)
    if (!updated) return err(c, 404, 'not_found', 'Preset not found.')
    return c.json(updated)
  })

  app.delete('/api/v1/models/:key/presets/:id', (c) => {
    const key = c.req.param('key')
    const id = c.req.param('id')
    const existing = (ownEntry(d.store.snapshot().modelPresets, key) ?? []).find((p) => p.id === id)
    if (!existing) return err(c, 404, 'not_found', 'Preset not found.')
    d.store.update((cfg) => {
      // Filter and assign back — never `delete cfg.modelPresets[key]`: a present-but-empty
      // array means "already seeded" to the seed migration, and dropping the key would
      // resurrect every deleted preset on the next load.
      cfg.modelPresets[key] = (ownEntry(cfg.modelPresets, key) ?? []).filter((p) => p.id !== id)
      if (ownEntry(cfg.lastPresetId, key) === id) delete cfg.lastPresetId[key]
    })
    return c.json({ ok: true })
  })

  app.post('/api/v1/models/:key/presets/:id/apply', (c) => {
    const key = c.req.param('key')
    const id = c.req.param('id')
    const existing = (ownEntry(d.store.snapshot().modelPresets, key) ?? []).find((p) => p.id === id)
    if (!existing) return err(c, 404, 'not_found', 'Preset not found.')
    // Pinning a stored preset whose flags differ from the model's current ones changes them for
    // the next load just as an edit would, whoever stored it.
    const launchRefused = launchFieldsRefusal(c, d, existing.profile, loadsWithNow(d, key, existing.engineId))
    if (launchRefused) return launchRefused
    d.store.update((cfg) => {
      ;(cfg.lastPresetId ??= {})[key] = id
    })
    return c.json(existing)
  })
}
