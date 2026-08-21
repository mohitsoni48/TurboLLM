import type { Config } from '../config/config'
import { isBoundedNumber, isConfigTheme } from '../config/config-bounds'

/** Turbo Link's `config:read` / `config:write` scope (spec §5.8, ADR-376).
 *
 *  ## Why this file exists
 *
 *  The naive reading of `config:write` — "accept a config patch and merge it" — is a total
 *  compromise of the capability model, not a rough edge in it. A peer holding nothing but
 *  `config:write` could:
 *
 *   - append to `apiKeys`, minting itself a full-access token and escaping its own grant;
 *   - edit its OWN key's `grant`, the same outcome by a shorter route;
 *   - delete every other key, locking the machine's owner out of their own links;
 *   - flip `daemon.lanBind` / `daemon.requireApiKey`, opening the host to the network;
 *   - rewrite `telemetry`, overriding a consent decision that is not the peer's to make;
 *   - rewrite `links`, pointing the host at a machine the owner never approved.
 *
 *  None of that is what "config" was ever meant to grant. So the capability is governed by
 *  an EXPLICIT ALLOWLIST of writable paths, and every bullet above is a named test in
 *  config-scope.test.ts — driven through `applyScopedPatch`, the function the route calls,
 *  not merely through the predicate.
 *
 *  This is the same principle that kept `engines:*` out of the capability set entirely
 *  (ADR-139), applied one level down: there, a remote caller must never name a binary to
 *  execute; here, a remote caller must never name a config key to write.
 *
 *  ## Four rules, each load-bearing
 *
 *  1. **Allowlist, never denylist.** A field added to the `Config` schema next quarter is
 *     NOT writable until someone deliberately adds it below and writes a test. A denylist
 *     would silently grant every future field.
 *  2. **Exact path segments, never string prefixes.** `modelDefaultsEvil` must not pass
 *     because `modelDefaults` does, and `daemon.theme` being writable must not make
 *     `daemon.themeAndAlsoLanBind` — or `daemon` itself — writable.
 *  3. **Allowlist PROJECTION on read, never a delete-list.** Building the read view by
 *     stripping known secrets guarantees the next secret added to `Config` leaks on the
 *     day it lands. This projects forward from a fixed list of leaves instead.
 *  4. **All-or-nothing writes.** A patch containing ANY rejected path applies NOTHING. A
 *     partial apply would let an attacker map the allowlist by bisection while still
 *     landing the permitted half of each probe.
 */

// ── Value shapes ────────────────────────────────────────────────────────────────────────
// `ConfigStore.update` runs `validate()`, but validate() says nothing about most of these
// leaves — it guards ports, absolute paths and agent invariants, not `modelDefaults.ctx`.
// A peer is a remote, semi-trusted caller, so each leaf carries its own shape check here.
// A value that fails one is `invalid` (a 400), which is deliberately a different answer
// from `rejected` (a 403): "that number is out of range" and "you may not touch that key
// at all" are different facts and must not be collapsed into one message.
//
// EVERY ranged/enumerated bound below is imported from config/config-bounds.ts — the SAME
// table the owner's own `PATCH /api/v1/settings` validates against. That is the fix for
// task 3's review finding 1: the remote bounds had drifted WIDER than the local ones
// (ctx < 256 and ngl = -1 both passed here, and neither is caught by config.validate(), so
// the out-of-range value persisted), letting a peer put the host into a state its owner's
// UI could not produce and could not re-produce in order to correct. Restating the numbers
// here — even correctly — would just re-arm the same drift, so this file holds none of them.
//
// The remote checks are deliberately STRICTER than the local ones, which is always
// allowed: `isBoundedNumber` takes no numeric strings and no fractions, because there is no
// form control on the far end that needs the leniency.

const isBool = (v: unknown): boolean => typeof v === 'boolean'

/** Every writable LEAF, with the shape its value must have. The keys of this record are
 *  the single source of truth for what `config:write` may touch and what `config:read`
 *  may disclose — add a line here and nowhere else.
 *
 *  Four groups, matching the four things this capability is for:
 *   - model defaults      — the base load profile a fleet operator wants uniform;
 *   - generation defaults — the per-response token cap, same reason;
 *   - gateway preferences — auto-swap and the keep-N pool, the knobs that decide how a
 *                           remote request is served;
 *   - UI preferences      — cosmetic, host-local, and carrying no security consequence.
 *
 *  Nothing else. Notably ABSENT and staying absent: `apiKeys`, `links`, `telemetry`, every
 *  `daemon` network field, `engines`/`activeEngineId`, `modelDirs`/`primaryModelDir`,
 *  `build.toolchainDirs`, `devModel`, `hf`, `tools`/`search` (credentials), `mcp`
 *  (spawns processes), `code` (filesystem candidates), `agents`/`customAgents`,
 *  `comfyui`, and `version` (the schema version the migrator owns). */
const WRITABLE_LEAVES: Record<string, (v: unknown) => boolean> = Object.assign(
  Object.create(null) as Record<string, (v: unknown) => boolean>,
  {
    // Model defaults — the base LoadProfile applied to a model with no saved profile.
    /** Default context window, in tokens. Floor of 256 — the owner's own slider's floor. */
    'modelDefaults.ctx': (v: unknown) => isBoundedNumber('modelDefaults.ctx', v),
    /** Default GPU layers to offload, 0-99. There is NO -1 "all layers" sentinel in this
     *  codebase: `profileToArgs` gates the flag on `p.ngl > 0`, so a negative value means
     *  `-ngl` is simply never emitted — the engine default, i.e. NO offload. An earlier
     *  version of this file accepted -1 and documented it as "all", which would have let a
     *  peer silently drop the host's own local model loads to CPU-only, at a value the
     *  owner's 0-99 control cannot even represent in order to correct it. */
    'modelDefaults.ngl': (v: unknown) => isBoundedNumber('modelDefaults.ngl', v),
    /** Generation default: hard cap on tokens per response (0 = unlimited). Worth stating
     *  plainly in the owner-facing copy: this cap is read by LOCAL in-app chat too, not only
     *  by what the peer asks for, so `config:write` is a knob on the host's own behaviour. */
    'modelDefaults.maxTokens': (v: unknown) => isBoundedNumber('modelDefaults.maxTokens', v),
    /** Generation default: cap on tokens spent encoding one image. */
    'modelDefaults.imageMaxTokens': (v: unknown) => isBoundedNumber('modelDefaults.imageMaxTokens', v),

    // Gateway preferences — how a request that names an unloaded model is served. Both are
    // resource-amplification knobs: they change how much VRAM the host commits on its
    // OWNER's subsequent local loads, not just on how the peer is served. Bounded,
    // recoverable, and both are values the owner's own UI can produce, so they stay — but
    // that is the honest description of what this capability grants.
    /** Auto-load the named model when a request asks for one that is not up. */
    'gateway.autoSwap': isBool,
    /** How many models stay hot at once. Bounded 1-4, same as the owner's own control. */
    'gateway.keepN': (v: unknown) => isBoundedNumber('gateway.keepN', v),

    // UI preferences — cosmetic and host-local. Enumerated, not free text: `theme` is typed
    // `string` in Config, and a free-text write is how a host path or a script fragment ends
    // up echoed back out through the read projection.
    'daemon.theme': isConfigTheme,
    /** Ask the local model to title new conversations. */
    'daemon.autoGenerateTitles': isBool,
  },
)

/** Whole-BLOCK writes: a path that replaces an entire object at once.
 *
 *  `daemon` is deliberately NOT here even though two of its leaves are writable — a
 *  whole-object write to `daemon` would replace `authToken`, `lanBind`, `requireApiKey`,
 *  `port` and `machineId` along with the two cosmetic fields, which is precisely the
 *  escalation this file exists to prevent. A block is only listed when EVERY one of its
 *  keys is itself writable.
 *
 *  The value is the set of keys a block write must supply: these mirror the REQUIRED
 *  (non-optional) fields of the corresponding `Config` interface, so a block write can
 *  never drop one of THOSE.
 *
 *  It is a replacement, not a merge, so the block's OPTIONAL leaves — `modelDefaults`'s
 *  `maxTokens` and `imageMaxTokens` — ARE dropped by a block write that omits them, and
 *  revert to their defaults. Deliberate, and not an escalation: both are themselves
 *  writable leaves a peer can already set directly, so the block write reaches nothing new.
 *  A peer that means to preserve them should patch the leaves instead. Pinned by
 *  `a block write REPLACES the block, dropping optional leaves` in config-scope.test.ts. */
const WRITABLE_BLOCKS: Record<string, readonly string[]> = Object.assign(
  Object.create(null) as Record<string, readonly string[]>,
  {
    modelDefaults: ['ctx', 'ngl'],
    gateway: ['autoSwap', 'keepN'],
  },
)

/** Every path `config:write` may address: the blocks, then their leaves. Sorted so the
 *  list is stable across runs and diffs cleanly when a line is added. */
export const WRITABLE_CONFIG_PATHS: readonly string[] = Object.freeze(
  [...Object.keys(WRITABLE_BLOCKS), ...Object.keys(WRITABLE_LEAVES)].sort(),
)

const WRITABLE_SET: ReadonlySet<string> = new Set(WRITABLE_CONFIG_PATHS)

/** Segments that must never appear in a path, at any depth. `__proto__` and
 *  `constructor.prototype` are the two ways a dotted-path setter turns into an
 *  Object.prototype pollution primitive; `prototype` is barred alongside them because a
 *  path is not worth parsing for which of the three spellings is currently exploitable. */
const POISON = new Set(['__proto__', 'constructor', 'prototype'])

/** May `config:write` address this exact path?
 *
 *  Matches on EXACT, whole path segments — the path is split, each segment is checked for
 *  a poison key and for emptiness (which rejects `''`, `'.'`, `'a.'`, `'.a'` and `'a..b'`
 *  alike), and the rejoined result must be a member of the allowlist SET. A `Set.has` is
 *  the whole match: there is no `startsWith`, no `includes`, and no normalisation that
 *  could widen it. `modelDefaultsEvil` fails because it is simply not in the set. */
export function isWritablePath(path: string): boolean {
  if (typeof path !== 'string' || path.length === 0 || path.length > 200) return false
  const segs = path.split('.')
  for (const s of segs) {
    if (s.length === 0 || POISON.has(s)) return false
    // A segment with surrounding whitespace is not the same key as the trimmed one, and
    // trimming it here would be a normalisation that widens the match. Reject instead.
    if (s !== s.trim()) return false
  }
  return WRITABLE_SET.has(segs.join('.'))
}

/** Does `value` — or anything nested inside it — carry a poison KEY?
 *
 *  `isWritablePath` guards the path; this guards the payload. `JSON.parse` happily
 *  produces an own `__proto__` property, and assigning such an object into the config
 *  would persist it to config.json, handing the next `JSON.parse`-and-merge a pollution
 *  primitive on a later boot. Depth-bounded so a deeply nested body cannot blow the stack
 *  before it is rejected. */
function hasPoisonedKeys(value: unknown, depth = 0): boolean {
  if (depth > 12) return true // too deep to audit ⇒ not accepted
  if (typeof value !== 'object' || value === null) return false
  if (Array.isArray(value)) return value.some((v) => hasPoisonedKeys(v, depth + 1))
  for (const k of Object.getOwnPropertyNames(value)) {
    if (POISON.has(k)) return true
    if (hasPoisonedKeys((value as Record<string, unknown>)[k], depth + 1)) return true
  }
  return false
}

/** Is `value` acceptable for the (already-allowed) path `path`? */
function isValidValue(path: string, value: unknown): boolean {
  if (value === undefined) return false
  if (hasPoisonedKeys(value)) return false
  const leaf = WRITABLE_LEAVES[path]
  if (leaf) return leaf(value)

  const required = WRITABLE_BLOCKS[path]
  if (!required) return false // unreachable: isWritablePath ran first
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const obj = value as Record<string, unknown>
  const keys = Object.getOwnPropertyNames(obj)
  // Every key present must itself be a writable leaf of this block — an unknown key would
  // otherwise ride into the config unvalidated, and a key belonging to a NON-writable
  // sibling would be a block write laundering a forbidden leaf.
  for (const k of keys) {
    if (!isValidValue(`${path}.${k}`, obj[k])) return false
    if (!WRITABLE_LEAVES[`${path}.${k}`]) return false
  }
  // …and no required field may be dropped by the replacement.
  return required.every((k) => keys.includes(k))
}

/** Read `a.b.c` out of `cfg`, or `undefined` if any hop is missing. */
function readPath(cfg: unknown, path: string): unknown {
  let cur: unknown = cfg
  for (const s of path.split('.')) {
    if (typeof cur !== 'object' || cur === null) return undefined
    cur = (cur as Record<string, unknown>)[s]
  }
  return cur
}

/** Write `a.b.c` into `cfg`, creating plain intermediate objects as needed.
 *  Only ever called with a path `isWritablePath` already approved, so every segment is a
 *  fixed, non-poison string from `WRITABLE_LEAVES`/`WRITABLE_BLOCKS`. */
function writePath(cfg: Record<string, unknown>, path: string, value: unknown): void {
  const segs = path.split('.')
  let cur = cfg
  for (const s of segs.slice(0, -1)) {
    const next = cur[s]
    if (typeof next !== 'object' || next === null || Array.isArray(next)) cur[s] = {}
    cur = cur[s] as Record<string, unknown>
  }
  cur[segs[segs.length - 1]!] = value
}

/** The peer-visible view of the host's config for `config:read`.
 *
 *  An ALLOWLIST PROJECTION, and specifically the projection of exactly
 *  `WRITABLE_LEAVES` — the read surface IS the write surface. Two consequences, both
 *  deliberate:
 *
 *   - **Nothing leaks by default.** A secret added to `Config` tomorrow — a new API key,
 *     a new token, a new absolute path — cannot appear here, because this builds the
 *     response forward from a fixed list of leaves rather than by deleting the fields
 *     someone remembered to name. The peer-facing surface has already paid for this rule
 *     three times over (the engine's `launchCommand`, `engine.error`'s log tail, and
 *     `DownloadRecord.dest`); it is not restated as a preference.
 *   - **No host filesystem detail can cross.** `modelDirs`, `primaryModelDir`, engine
 *     `binPath`s, `build.toolchainDirs`, `comfyui.gatePath` and `devModel.modelPath` are
 *     not leaves, so there is no code path that emits them.
 *
 *  Values are emitted only when they pass their own leaf validator. A hand-edited
 *  config.json holding a string where a number belongs is therefore omitted rather than
 *  echoed back — which is also what guarantees only bounded numbers, booleans and one of
 *  three theme words ever reach a peer. */
export function scrubConfigForRead(cfg: Config): unknown {
  const out: Record<string, unknown> = {}
  for (const [path, valid] of Object.entries(WRITABLE_LEAVES)) {
    const v = readPath(cfg, path)
    if (v === undefined || !valid(v)) continue
    writePath(out, path, v)
  }
  return out
}

export type ScopedPatchResult =
  | { ok: true; applied: string[] }
  /** `rejected` = paths this link may never write (a 403). `invalid` = allowed paths whose
   *  VALUE failed its shape check (a 400). Both mean nothing was applied; they are kept
   *  apart so the route can answer the question the peer actually asked. */
  | { ok: false; rejected: string[]; invalid: string[] }

/** Apply a flat, dotted-path patch to `cfg`, in place — ATOMICALLY.
 *
 *  The whole patch is validated before a single byte is mutated. If ANY path is outside
 *  the allowlist, or any value fails its shape check, NOTHING is applied and the offending
 *  paths are named. That atomicity is a security property, not a nicety: a partial apply
 *  would let a peer binary-search the allowlist (send two paths, see which half landed)
 *  while still getting the permitted half of every probe applied for free.
 *
 *  Mutates `cfg` rather than returning a copy so the caller can hand it straight to
 *  `ConfigStore.update`, whose callback mutates a clone and then runs the daemon's own
 *  `validate()` — this scope is the outer gate, not a replacement for it. */
export function applyScopedPatch(cfg: Config, patch: Record<string, unknown>): ScopedPatchResult {
  if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) {
    return { ok: false, rejected: [], invalid: [] }
  }

  const entries = Object.getOwnPropertyNames(patch).map(
    (k) => [k, (patch as Record<string, unknown>)[k]] as const,
  )

  const rejected: string[] = []
  const invalid: string[] = []
  for (const [path, value] of entries) {
    if (!isWritablePath(path)) rejected.push(path)
    else if (!isValidValue(path, value)) invalid.push(path)
  }
  if (rejected.length > 0 || invalid.length > 0) return { ok: false, rejected, invalid }

  const applied: string[] = []
  for (const [path, value] of entries) {
    writePath(cfg as unknown as Record<string, unknown>, path, value)
    applied.push(path)
  }
  return { ok: true, applied }
}
