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
// that omits `gpu`/`nCpuMoe` still writes cleanly. `requireCtx` is the one caller-dependent knob —
// the profile route demands a usable ctx, a preset patch may legitimately omit it.

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
    if (!['layer', 'row', 'none'].includes(g.splitMode as string)) {
      return 'gpu.splitMode must be layer, row, or none.'
    }
    if (!Array.isArray(g.tensorSplit) || g.tensorSplit.some((n) => typeof n !== 'number' || !(n >= 0))) {
      return 'gpu.tensorSplit must be an array of non-negative numbers.'
    }
    if (!Number.isInteger(g.mainGpu) || (g.mainGpu as number) < -1) {
      return 'gpu.mainGpu must be an integer ≥ -1.'
    }
    if (!Number.isInteger(g.tensorParallelSize) || (g.tensorParallelSize as number) < 1) {
      return 'gpu.tensorParallelSize must be an integer ≥ 1.'
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

  return null
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
