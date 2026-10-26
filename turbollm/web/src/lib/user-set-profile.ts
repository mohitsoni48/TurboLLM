// What the model dialog keeps of the user's own choices, so that it sends and saves only those.
//
// The dialog used to seed its draft from the resolved profile (the built-in defaults, the global
// Model Defaults and the saved profile merged) and to send and save that whole draft on every Load,
// Save, "Save as…" preset and Auto-tune, with "Remember these settings" on by default. A default
// then became the user's choice the first time anything was saved: Settings > Model Defaults (context,
// GPU layers) stopped reaching every model loaded once from the dialog, and a LiteRT-LM bundle's own
// context and sampler could never apply, because TurboLLM's llama.cpp values sat in its profile as if
// the user had picked them. The daemon reads such an earlier profile the same way (profile.ts
// userSetProfile); the dialog marks what it saves now (`userSetOnly`), so every field it carries is the
// user's, whatever its value.
import type { LoadProfile, UserSetProfile } from './types'

/** The groups the daemon merges key by key (resolveProfile), so a user's choice in one is kept per key. */
export type ProfileGroup = 'sampling' | 'gpu' | 'vllm' | 'litertLm'
const GROUPS: ReadonlySet<string> = new Set<ProfileGroup>(['sampling', 'gpu', 'vllm', 'litertLm'])

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/** `u` with the user's value `v` for top-level field `k`. */
export function withUserValue<K extends keyof LoadProfile>(u: UserSetProfile, k: K, v: LoadProfile[K]): UserSetProfile {
  return { ...u, [k]: v }
}

/** `u` with the user's value `v` for key `k` of group `g`. */
export function withUserGroupValue(u: UserSetProfile, g: ProfileGroup, k: string, v: unknown): UserSetProfile {
  return { ...u, [g]: { ...((u[g] as Record<string, unknown> | undefined) ?? {}), [k]: v } }
}

/** The fields of a stored profile or preset the user set, against `auto` (the profile the model loads
 *  with when nothing is set). The daemon's profile.ts userSetProfile, for a preset applied in the dialog:
 *  one marked `userSetOnly` is the user's in every field; one an earlier build stored whole holds the
 *  defaults the dialog was seeded with too, and its fields equal to `auto` are read as not set. */
export function userSetView(p: UserSetProfile | undefined, auto: LoadProfile): UserSetProfile {
  if (!p || typeof p !== 'object') return {}
  const marked = p.userSetOnly === true
  const autoFields = auto as unknown as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(p)) {
    if (v === undefined || k === 'userSetOnly') continue
    if (marked || k === 'tunedBy') {
      out[k] = v
      continue
    }
    if (GROUPS.has(k) && v && typeof v === 'object' && !Array.isArray(v)) {
      const autoGroup = (autoFields[k] ?? {}) as Record<string, unknown>
      const group: Record<string, unknown> = {}
      for (const [gk, gv] of Object.entries(v as Record<string, unknown>)) {
        if (gv !== undefined && !same(gv, autoGroup[gk])) group[gk] = gv
      }
      if (Object.keys(group).length > 0) out[k] = group
      continue
    }
    if (!same(v, autoFields[k])) out[k] = v
  }
  return out as UserSetProfile
}

/** The full profile the dialog shows for the user's choices `u` over `base`, the groups merged key by key. */
export function withUserSet(base: LoadProfile, u: UserSetProfile): LoadProfile {
  const out: Record<string, unknown> = { ...base }
  for (const [k, v] of Object.entries(u)) {
    if (v === undefined || k === 'userSetOnly') continue
    out[k] = GROUPS.has(k) && v && typeof v === 'object' && !Array.isArray(v)
      ? { ...((base as unknown as Record<string, Record<string, unknown> | undefined>)[k] ?? {}), ...(v as Record<string, unknown>) }
      : v
  }
  return out as LoadProfile
}

/** What the dialog sends: the user's choices, marked as holding only those. */
export function userSetPayload(u: UserSetProfile): UserSetProfile {
  const { userSetOnly: _marker, ...fields } = u
  return { ...fields, userSetOnly: true }
}
