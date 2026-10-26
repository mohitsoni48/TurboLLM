// Shared load-profile field validation for the two write paths that accept a profile from a
// client: `PUT /api/v1/models/:key/profile` and the preset create/update routes (ADR-353).
//
// Why it is shared: a stored profile is handed verbatim to `profileToArgs`, which turns it into
// an engine command line. A bad field is not a display problem — `gpu.tensorSplit` that is not an
// array throws inside `profileToArgs`, and a stored `nCpuMoe: null` becomes a literal
// `--n-cpu-moe null` argument. The profile route has rejected these at the boundary since the
// 2026-08-06 fix; presets are a SECOND way into the same storage and must reject them identically,
// or a preset can be pinned and make a model unloadable until the pin is cleared by hand.
//
// Partial-tolerant by design: every check is skipped when the field is absent, so an older client
// that omits `gpu`/`nCpuMoe` still writes cleanly, and so is every key of `gpu`, which a profile of
// only what the user set (userSetOnly) carries one by one. `requireCtx` is the one caller-dependent
// knob — the profile route demands a usable ctx from a whole profile, a preset patch and a profile of
// only what the user set may legitimately omit it.
//
// Also the one launch-field gate (launchFieldsRefusal) for every route that takes a profile from a
// client: the two above, POST /api/v1/engine/start's overrides, a preset's /apply and the
// auto-tune base.

import type { Context } from 'hono'
import { isLocalOrAuthenticated } from '../auth'
import { getModelProfile } from '../config/config'
import type { Deps } from '../deps'
import { CACHE_RAM_MAX_MIB, isCacheRamMib, tokenizeExtraArgs } from '../models/profile'

/** Whether `p` holds only what the user set (LoadProfile.userSetOnly): the model dialog's saves and presets. */
export function isUserSetOnly(p: unknown): boolean {
  return !!p && typeof p === 'object' && (p as { userSetOnly?: unknown }).userSetOnly === true
}

/** Returns a human-readable reason the profile is invalid, or `null` when it is acceptable. */
export function validateLoadProfileFields(p: unknown, opts: { requireCtx: boolean }): string | null {
  if (!p || typeof p !== 'object' || Array.isArray(p)) return 'profile must be a JSON object.'
  const prof = p as Record<string, unknown>

  const ctx = prof.ctx
  if (opts.requireCtx || ctx !== undefined) {
    if (typeof ctx !== 'number' || !Number.isFinite(ctx) || ctx < 256) {
      return 'ctx must be at least 256.'
    }
  }

  // Multi-GPU split settings (ADR-054), validated only when present.
  if (prof.gpu !== undefined) {
    const g = prof.gpu as Record<string, unknown>
    if (!g || typeof g !== 'object' || Array.isArray(g)) return 'gpu must be a JSON object.'
    // A whole profile carries every key; one of only what the user set, the keys the user changed.
    const whole = !isUserSetOnly(p)
    if ((whole || g.splitMode !== undefined) && !['layer', 'row', 'none'].includes(g.splitMode as string)) {
      return 'gpu.splitMode must be layer, row, or none.'
    }
    if ((whole || g.tensorSplit !== undefined) && (!Array.isArray(g.tensorSplit) || g.tensorSplit.some((n) => typeof n !== 'number' || !(n >= 0)))) {
      return 'gpu.tensorSplit must be an array of non-negative numbers.'
    }
    if ((whole || g.mainGpu !== undefined) && (!Number.isInteger(g.mainGpu) || (g.mainGpu as number) < -1)) {
      return 'gpu.mainGpu must be an integer ≥ -1.'
    }
    if ((whole || g.tensorParallelSize !== undefined) && (!Number.isInteger(g.tensorParallelSize) || (g.tensorParallelSize as number) < 1)) {
      return 'gpu.tensorParallelSize must be an integer ≥ 1.'
    }
  }

  if (prof.litertLm !== undefined) {
    const l = prof.litertLm as Record<string, unknown>
    if (!l || typeof l !== 'object' || Array.isArray(l)) return 'litertLm must be a JSON object.'
    if (l.backend !== undefined && !['auto', 'cpu', 'gpu'].includes(l.backend as string)) {
      return 'litertLm.backend must be auto, cpu, or gpu.'
    }
  }

  if (prof.nCpuMoe !== undefined) {
    const n = prof.nCpuMoe
    if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) {
      return 'nCpuMoe must be a non-negative number.'
    }
  }

  if (prof.ngl !== undefined) {
    const n = prof.ngl
    if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) {
      return 'ngl must be a non-negative number.'
    }
  }

  if (prof.cacheRam !== undefined && !isCacheRamMib(prof.cacheRam)) {
    return `cacheRam must be a non-negative whole number of MiB, at most ${CACHE_RAM_MAX_MIB} (0 disables the prompt cache).`
  }

  return null
}

/** The load-profile fields that put something of the caller's choosing on the engine's command
 *  line, with what the refusal calls setting them. profileToArgs appends `extraArgs` verbatim
 *  after every flag it builds (so they override any of them: `--host 0.0.0.0`, `--log-file
 *  <path>`, `--model <path>`), and hands the engine the next three paths to open.
 *  `vllm.trustRemoteCode` is the one switch that runs code: vllmProfileToArgs turns it into
 *  `--trust-remote-code`, on which vLLM imports the Python a model's repo ships, and a caller
 *  without a key may download any repo's files, so it is `extraArgs: ['--trust-remote-code']`
 *  by another name. The rest of a profile only fills in single values of flags TurboLLM itself
 *  chose, none of which opens a file or runs code of the caller's choosing. A dotted name reads
 *  one level down (launchField). */
const LAUNCH_FIELDS = [
  ['extraArgs', 'Setting extra command-line flags'],
  ['chatTemplateFile', 'Setting a chat template file'],
  ['draftModelPath', 'Setting a draft model from outside the library'],
  ['mtpHeadPath', 'Setting an MTP head file from outside the library'],
  ['vllm.trustRemoteCode', "Trusting a model's remote code"],
] as const

/** Launch field `field` of profile `p` (a dotted name one level down), or undefined. */
function launchField(p: unknown, field: string): unknown {
  let v = p
  for (const part of field.split('.')) v = v && typeof v === 'object' ? (v as Record<string, unknown>)[part] : undefined
  return v
}

/** How a launch field reads on the command line, so that two spellings of one launch compare
 *  equal: extraArgs split the way resolveProfile splits it for every load, a path as itself, the
 *  vLLM switch as on or off (vllmProfileToArgs tests it for truth), and an absent or null field
 *  as none (no flags, no path, off; over a saved profile it keeps the saved value). Anything else
 *  compares as its JSON. */
function launchValue(field: string, v: unknown): string {
  if (field === 'vllm.trustRemoteCode') return v ? 'true' : 'false'
  if (v === undefined || v === null) return field === 'extraArgs' ? '[]' : '""'
  if (field === 'extraArgs' && Array.isArray(v)) return JSON.stringify(tokenizeExtraArgs(v))
  return JSON.stringify(v) ?? ''
}

/** The first launch field (LAUNCH_FIELDS) that `p` sets to a value of the caller's own, or null.
 *  A value is not the caller's own when it is none, when `current()` (the profile the model loads
 *  with now, or the preset being edited) already holds it, or, for the draft and MTP model files,
 *  when it is a model in the library, which the caller may load anyway. */
export function launchFieldChosen(
  p: unknown,
  current: () => unknown,
  inLibrary: (path: string) => boolean,
): { field: string; phrase: string } | null {
  if (!p || typeof p !== 'object' || Array.isArray(p)) return null
  for (const [field, phrase] of LAUNCH_FIELDS) {
    const sent = launchField(p, field)
    const v = launchValue(field, sent)
    if (v === launchValue(field, undefined)) continue
    if (v === launchValue(field, launchField(current(), field))) continue
    if ((field === 'draftModelPath' || field === 'mtpHeadPath') && typeof sent === 'string' && inLibrary(sent)) continue
    return { field, phrase }
  }
  return null
}

/** What model `key` loads with now on `engineId` ('' for the active engine): the profile
 *  getModelProfile serves the next load (the pinned preset, else the engine's saved profile), and
 *  what GET /api/v1/models/:key shows the dialog, so what launchFieldsRefusal compares with. */
export function loadsWithNow(d: Deps, key: string, engineId: string): () => unknown {
  return () => getModelProfile(d.store.snapshot(), key, engineId || d.registry.active()?.id || '*')
}

/** The refusal for a caller that may not choose what goes on the engine's command line: 403
 *  api_key_required, on which the web client opens its key prompt, with `field` naming it. */
export function launchKeyRequired(c: Context, field: string, phrase: string): Response {
  return c.json({ error: { code: 'api_key_required', message: `${phrase} requires a valid API key.`, field } }, 403)
}

/** That refusal when profile `p` sets a launch field to a value of the caller's own
 *  (launchFieldChosen) and the caller is neither on this machine nor holding a real key, else
 *  null. ADR-139 keeps caller-chosen arguments and paths off the engine's command line for remote
 *  callers, and /build/run, engine add and an engine's source repo apply this same
 *  isLocalOrAuthenticated rule; without it a keyless Tailscale Serve identity, Cloudflare Access
 *  login or open-LAN peer, or a remote-access token with models:load, could load a model with
 *  flags and files of its own, or with vLLM running a repo's code, or store them in a profile,
 *  preset or tune for the owner's next load. An unchanged echo still passes, as the web UI sends
 *  its whole draft (the profile the model loads with now) on every Load, Save, Save as preset
 *  and Auto-tune. */
export function launchFieldsRefusal(c: Context, d: Deps, p: unknown, current: () => unknown): Response | null {
  const chosen = launchFieldChosen(p, current, (path) => d.scanner.list().models.some((m) => m.path === path))
  if (!chosen || isLocalOrAuthenticated(c, d)) return null
  return launchKeyRequired(c, chosen.field, chosen.phrase)
}

/** Order-independent deep equality for two stored profiles.
 *
 *  Used to decide whether a manual profile save actually diverges from the pinned preset. A save
 *  that writes exactly the pinned preset's values (the Load button's "Remember these settings",
 *  which fires on the draft the preset just filled in) must NOT unpin it — otherwise the
 *  advertised "your pick is remembered and auto-applied on the next load" is false on the default
 *  path. A save that genuinely changes something still supersedes the pin. */
export function profilesEqual(a: unknown, b: unknown): boolean {
  return canonical(a) === canonical(b)
}

function canonical(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null'
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`
  const o = v as Record<string, unknown>
  const keys = Object.keys(o).filter((k) => o[k] !== undefined).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(',')}}`
}
