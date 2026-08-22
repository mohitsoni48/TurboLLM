/** Value bounds shared by the LOCAL settings route (`PATCH /api/v1/settings`,
 *  api/routes.ts) and the Turbo Link config scope (`PATCH /api/link/v1/config`,
 *  link/config-scope.ts).
 *
 *  ## Why this table exists
 *
 *  Task 3's review found the remote bounds were WIDER than the local ones: a linked peer
 *  could set `modelDefaults.ctx` below 256 and `modelDefaults.ngl` to -1, both of which the
 *  owner's own UI rejects, and neither of which `config.ts`'s `validate()` checks — so the
 *  out-of-range value persisted. That inverts the intended relationship. **A remote caller
 *  holding a scoped grant must never be able to do more than the owner sitting at the
 *  machine.**
 *
 *  The fix is not a second bounds table in config-scope.ts that happens to agree with this
 *  one today. Two copies of a bounds table is exactly the drift pattern that produced the
 *  finding in the first place. So the numbers live here, once, and both routes derive from
 *  them — a bound changed for the local UI moves the remote gate with it, automatically.
 *
 *  ## What is NOT here
 *
 *  Only the paths where a *numeric range* or an *enum* is the rule. Booleans need no table
 *  (the local route coerces with `!!`, the remote scope requires a real boolean — narrower,
 *  which is always allowed). Fields the remote scope does not expose at all — `port`,
 *  `idleTtlMinutes`, `vramHeadroomMb`, `comfyui.url` — keep their validation in
 *  api/routes.ts, because sharing a bound for a path only one side can write would imply a
 *  symmetry that does not exist.
 *
 *  ## The invariant
 *
 *  Remote may be NARROWER than local, never wider. `isBoundedNumber` is deliberately
 *  stricter than `coerceBounded`: it takes no strings and no fractions, because a peer is a
 *  remote semi-trusted caller and there is no UI on the other end whose form control needs
 *  the leniency. */

/** How the LOCAL route turns a user-supplied value into the stored one. Faithful to what
 *  api/routes.ts did before this table existed, per path — the two policies are not
 *  interchangeable and collapsing them would silently change local behaviour:
 *   - `floor`   — range-check the finite number FIRST, then `Math.floor` it. Order matters:
 *                 `ngl: 99.7` must fail the 0–99 check, not floor to a passing 99.
 *   - `integer` — reject anything that is not already an integer. */
export type BoundCoercion = 'floor' | 'integer'

export interface NumericBound {
  readonly min: number
  readonly max: number
  readonly coerce: BoundCoercion
  /** The exact 400 message the local route emits. Kept beside the numbers so a changed
   *  bound cannot leave a stale message behind. */
  readonly message: string
}

export const CONFIG_BOUNDS = {
  'modelDefaults.ctx': {
    min: 256,
    max: Number.MAX_SAFE_INTEGER,
    coerce: 'floor',
    message: 'modelDefaults.ctx must be at least 256.',
  },
  /** 0–99, and 0 means "no GPU offload". There is NO -1 sentinel in this codebase:
   *  `profileToArgs` gates the flag on `p.ngl > 0`, so a negative value simply means
   *  `-ngl` is never emitted — the engine default, not "all layers". */
  'modelDefaults.ngl': {
    min: 0,
    max: 99,
    coerce: 'floor',
    message: 'modelDefaults.ngl must be 0–99.',
  },
  'modelDefaults.imageMaxTokens': {
    min: 0,
    max: Number.MAX_SAFE_INTEGER,
    coerce: 'floor',
    message: 'modelDefaults.imageMaxTokens must be a non-negative number.',
  },
  'modelDefaults.maxTokens': {
    min: 0,
    max: Number.MAX_SAFE_INTEGER,
    coerce: 'floor',
    message: 'modelDefaults.maxTokens must be a non-negative number (0 = unlimited).',
  },
  'gateway.keepN': {
    min: 1,
    max: 4,
    coerce: 'integer',
    message: 'gateway.keepN must be 1–4.',
  },
} as const satisfies Record<string, NumericBound>

export type BoundedConfigPath = keyof typeof CONFIG_BOUNDS

/** The daemon's theme enum. `Daemon.theme` is typed as a bare `string`, so this list is the
 *  only thing that makes it an enum anywhere — shared so the remote gate cannot drift from
 *  the local one, and so a fourth theme is added in exactly one place. */
export const CONFIG_THEMES = ['system', 'light', 'dark'] as const

export function isConfigTheme(v: unknown): boolean {
  return typeof v === 'string' && (CONFIG_THEMES as readonly string[]).includes(v)
}

/** LOCAL policy: coerce, then range-check. Returns the value to store, or `null` when the
 *  caller should answer 400 with `CONFIG_BOUNDS[path].message`. */
export function coerceBounded(path: BoundedConfigPath, raw: unknown): number | null {
  const b = CONFIG_BOUNDS[path]
  const v = Number(raw)
  if (b.coerce === 'integer') {
    if (!Number.isInteger(v) || v < b.min || v > b.max) return null
    return v
  }
  if (!Number.isFinite(v) || v < b.min || v > b.max) return null
  return Math.floor(v)
}

/** REMOTE policy: no coercion at all. The value must already be an integer inside the same
 *  range the local route enforces — strictly a subset of what `coerceBounded` accepts, so
 *  a linked peer can never reach a state the owner's own UI could not produce. */
export function isBoundedNumber(path: BoundedConfigPath, v: unknown): boolean {
  const b = CONFIG_BOUNDS[path]
  return typeof v === 'number' && Number.isInteger(v) && v >= b.min && v <= b.max
}
