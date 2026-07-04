// Local feature-flag manager — internal/dev only, deliberately undocumented in any
// user-facing README. Lets an experimental feature ship in code without being live for
// normal users yet: set TURBOLLM_FEATURES to a comma-separated list of flag ids to turn
// them on (e.g. `TURBOLLM_FEATURES=cloud-deploy npx turbollm`). Discoverable by reading
// the source, not by reading docs — the point is letting people exploring the codebase
// find and try what's still in progress, without it being an advertised feature yet.
//
// KNOWN_FEATURES is the registry: the one place that lists every flag that currently
// exists. Anything not listed here is silently ignored even if set in the env var, so a
// typo can't accidentally "half enable" garbage.
const KNOWN_FEATURES = ['cloud-deploy'] as const

export type FeatureId = (typeof KNOWN_FEATURES)[number]

/** Feature ids enabled for this process, parsed from TURBOLLM_FEATURES fresh on every
 *  call (not cached) — cheap enough that testability matters more than the micro-cost
 *  of re-splitting a short string, and env vars don't change mid-process anyway. */
export function enabledFeatures(): FeatureId[] {
  const raw = process.env.TURBOLLM_FEATURES ?? ''
  const requested = new Set(
    raw.split(',').map((s) => s.trim()).filter(Boolean),
  )
  return KNOWN_FEATURES.filter((f) => requested.has(f))
}

export function isFeatureEnabled(id: FeatureId): boolean {
  return enabledFeatures().includes(id)
}
