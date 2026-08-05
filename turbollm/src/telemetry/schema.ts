/**
 * Telemetry event schema — the single source of truth for what may be sent
 * (ADR-299 Decision 6, `architecture/08-telemetry-and-consent.md`).
 *
 * This module is deliberately dependency-free so the Cloudflare Worker can
 * import `validateEvent` verbatim: the allow-list must never drift between the
 * client that emits and the edge that ingests, or the privacy claim and the
 * abuse filter stop agreeing with each other.
 *
 * The load-bearing rule (ADR-299): **every field is an enum defined here, and
 * there are no free-form strings.** That one rule is simultaneously the privacy
 * guarantee (a prompt or a path cannot be expressed), the cardinality control,
 * and the primary anti-abuse filter.
 */

/** Wire-format version. Bump only for a breaking payload change. */
export const TELEMETRY_SCHEMA_VERSION = 1

/** Every event name that may ever be sent. Anything else is rejected. */
export const EVENT_NAMES = [
  'app_first_run',
  'daily_active',
  'onboarding_step',
  'model_first_load',
  'feature_first_use',
  'feature_used_daily',
  'error',
  'consent_choice',
  'bench_result',
] as const

export type EventName = (typeof EVENT_NAMES)[number]

/** The only keys that may appear at the top level of any event. An unknown key
 *  is a hard reject rather than something we strip: silently dropping it would
 *  hide a caller that thinks it is sending data we never store. */
export const ENVELOPE_KEYS = ['schema', 'event', 'ts', 'machineId', 'app', 'hw', 'payload', 'level'] as const

/** Product surfaces we count discovery/usage for. Closed set by construction —
 *  a repo name or a chat title can never be expressed as one of these. */
export const FEATURES = [
  'chat', 'code', 'research', 'artifacts', 'mcp', 'agents', 'autotune', 'skills', 'image',
] as const

/** Steps in the install → first-chat journey (ADR-299 Decision 6, amended by
 *  ADR-323). `engine_build` was on this list originally but is not on the
 *  automatic path at all: `seedDefaultEngines` only ever provisions a prebuilt
 *  binary, and building from source is a later, manual, advanced-user action —
 *  so the step read as near-total drop-off for the entire install base rather
 *  than as a real signal. `first_chat` replaces it as the last step, because
 *  "the model loaded" is one step short of the actual success criterion. */
export const ONBOARDING_STEPS = ['engine_install', 'model_download', 'first_load', 'first_chat'] as const

/** How a step or a load ended. */
export const OUTCOMES = ['ok', 'fail', 'cancelled'] as const

/** Why a load failed. Enum'd precisely so a failure can never carry a path or a
 *  driver string — `other` is the deliberate catch-all for the long tail. */
export const FAIL_REASONS = [
  'oom', 'no_engine', 'bad_gguf', 'unsupported_arch', 'timeout', 'cancelled', 'other',
] as const

/** Why provisioning a prebuilt engine failed (`onboarding_step: engine_install`
 *  only — see `classifyProvisionFailure`). A separate enum from `FAIL_REASONS`:
 *  installing an engine archive and loading a model fail in different ways
 *  (network/asset/platform vs. oom/arch/corruption), so the two vocabularies
 *  don't overlap much and shouldn't be merged into one. */
export const PROVISION_FAIL_REASONS = [
  'network', 'no_asset', 'unsupported_platform', 'disk_full', 'permission_denied', 'other',
] as const

/** Usage counts are bucketed, never raw: a raw count is a behavioural fingerprint. */
export const COUNT_BUCKETS = ['1', '2-5', '6-20', '21-100', '100+'] as const

/** Known failure classes. Never log text — a fingerprint the client already
 *  recognises, or nothing at all. */
export const ERROR_FINGERPRINTS = [
  'cuda_oom', 'engine_crash', 'engine_start_timeout', 'model_load_failed',
  'gateway_unreachable', 'download_failed', 'build_failed', 'other',
] as const

/** Consent levels, as sent by `consent_choice`. */
export const CONSENT_LEVELS = ['off', 'anon', 'full'] as const

/** Max length of an identifier string (see {@link isSafeIdent}). Comfortably fits
 *  the longest real model/CPU names while leaving no room to smuggle prose. */
export const MAX_IDENT_LEN = 96

/**
 * Identifier strings — the ONE place free-form text is allowed, and only for
 * public hardware/model identifiers on `bench_result` (model name, quant, arch,
 * engine version, CPU, GPU).
 *
 * ADR-299 states the rule as "every field is an enum, no free-form strings,
 * ever." That is true of every journey event but cannot hold here: the
 * benchmark dataset's whole value is the join key `(model, quant, GPU)`, and
 * that space is open — any GGUF on Hugging Face, any GPU. Enumerating it is
 * impossible, and normalising to a known catalogue would discard exactly the
 * long-tail models the public benchmark pages exist to cover.
 *
 * So these six fields are constrained instead of enumerated: capped length,
 * printable ASCII only, and no path-shaped content. A prompt, a file path, or a
 * key cannot survive those three rules together.
 */
function isSafeIdent(v: unknown): boolean {
  if (typeof v !== 'string' || v.length === 0 || v.length > MAX_IDENT_LEN) return false
  if (!/^[A-Za-z0-9 ._:()+\-]+$/.test(v)) return false // no slashes, backslashes, control chars
  if (v.includes('..')) return false // no traversal-shaped values
  return true
}

/**
 * `app.os`, specifically — NOT a general identifier.
 *
 * `getSysInfo().os` (sysinfo.ts) is always `${process.platform}/${process.arch}`
 * (e.g. "win32/x64", "darwin/arm64"), and every real `Emitter.emit()` call embeds
 * it unconditionally. `isSafeIdent` forbids slashes — correctly, for the six
 * `bench_result` fields where a slash could be part of a smuggled path — but
 * `os` is never attacker- or user-influenceable: it comes straight from Node's
 * own runtime introspection, not from a hardware string or a file. Found live,
 * running the real daemon end-to-end: before this, EVERY journey event was
 * silently rejected at this exact field, on every platform, always.
 *
 * Scoped narrowly rather than loosening `isSafeIdent` itself: exactly one slash
 * between two short lowercase-alnum tokens. A real filesystem path (multiple
 * segments, dots, drive letters, backslashes) cannot pass this.
 */
function isSafeOs(v: unknown): boolean {
  return typeof v === 'string' && /^[a-z0-9]{1,32}\/[a-z0-9]{1,32}$/.test(v)
}

/** Payload field specs, per event. A field is a closed enum, a capped
 *  identifier, a number, or a boolean. Anything not listed cannot be sent. */
type FieldSpec =
  | { enum: readonly string[]; optional?: boolean }
  | { kind: 'ident' | 'os' | 'number' | 'boolean'; optional?: boolean; nullable?: boolean }

/** Nested object specs for `bench_result` (and any future structured event). */
const BENCH_PAYLOAD: Record<string, Record<string, FieldSpec>> = {
  model: {
    name: { kind: 'ident' },
    quant: { kind: 'ident' },
    arch: { kind: 'ident' },
    sizeBytes: { kind: 'number' },
    moe: { kind: 'boolean' },
  },
  engine: { version: { kind: 'ident' } },
  params: {
    ctx: { kind: 'number' },
    ngl: { kind: 'number' },
    nglFit: { kind: 'boolean', optional: true },
    nCpuMoe: { kind: 'number' },
    nCpuMoeFit: { kind: 'boolean', optional: true },
    parallel: { kind: 'number' },
    kvTypeK: { kind: 'ident' },
    flashAttn: { kind: 'ident' },
  },
  result: {
    tps: { kind: 'number' },
    ttftMs: { kind: 'number' },
    // `null` is real data here: BenchResult.vramMb is `number | null`, meaning
    // "we could not measure VRAM on this box" — distinct from "not reported".
    vramMb: { kind: 'number', optional: true, nullable: true },
    outcome: { enum: OUTCOMES },
  },
}

/** Hardware block — only present on `bench_result`. */
const HW_SPEC: Record<string, FieldSpec> = {
  cpu: { kind: 'ident' },
  ramMb: { kind: 'number' },
}

const PAYLOAD_SPECS: Record<string, Record<string, FieldSpec>> = {
  // `failReason` is optional and, today, only ever sent for `step: 'engine_install'`
  // (classified by `classifyProvisionFailure`, PROVISION_FAIL_REASONS) — mirrors
  // `model_first_load.failReason`'s own "optional, only present on a real failure"
  // shape. Not step-conditional at the schema level (this validator is flat per
  // event name, not per payload value) — enforced by convention at the one call
  // site that sends it (cli.ts's `provision.onSettled`), same as elsewhere in this
  // file's payload specs.
  onboarding_step: { step: { enum: ONBOARDING_STEPS }, outcome: { enum: OUTCOMES }, failReason: { enum: PROVISION_FAIL_REASONS, optional: true } },
  model_first_load: { outcome: { enum: OUTCOMES }, failReason: { enum: FAIL_REASONS, optional: true } },
  feature_first_use: { feature: { enum: FEATURES } },
  feature_used_daily: { feature: { enum: FEATURES }, countBucket: { enum: COUNT_BUCKETS } },
  error: { fingerprint: { enum: ERROR_FINGERPRINTS } },
}

/** Check a flat object against a field spec. Returns an error string or null.
 *  `path` is used only to build a readable rejection reason. */
function checkFields(obj: unknown, spec: Record<string, FieldSpec>, path: string): string | null {
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
    return `${path} must be an object`
  }
  const o = obj as Record<string, unknown>

  for (const key of Object.keys(o)) {
    // Object.prototype.hasOwnProperty, NOT `key in spec` — `in` walks the
    // prototype chain, so 'toString'/'constructor'/'valueOf' etc. would pass
    // as "known fields" here and then never be validated at all, since the
    // loop below only iterates the spec's OWN entries (found in pre-release
    // review). `spec` is always our own literal object, so this call can never
    // itself fail on a missing hasOwnProperty.
    if (!Object.prototype.hasOwnProperty.call(spec, key)) return `unknown field: ${path}.${key}`
  }
  for (const [key, field] of Object.entries(spec)) {
    const v = o[key]
    if (v === undefined) {
      if (field.optional) continue
      return `missing field: ${path}.${key}`
    }
    const where = `${path}.${key}`
    if (v === null && !('enum' in field) && field.nullable) continue
    if ('enum' in field) {
      if (typeof v !== 'string' || !field.enum.includes(v)) return `invalid value for ${where}: ${String(v)}`
    } else if (field.kind === 'ident') {
      if (!isSafeIdent(v)) return `invalid value for ${where}`
    } else if (field.kind === 'os') {
      if (!isSafeOs(v)) return `invalid value for ${where}`
    } else if (field.kind === 'number') {
      if (typeof v !== 'number' || !Number.isFinite(v)) return `invalid value for ${where}: ${String(v)}`
    } else if (typeof v !== 'boolean') {
      return `invalid value for ${where}: ${String(v)}`
    }
  }
  return null
}

/** Validate the `hw` block (bench_result only). */
function validateHw(hw: unknown): string | null {
  if (typeof hw !== 'object' || hw === null || Array.isArray(hw)) return 'hw must be an object'
  const h = hw as Record<string, unknown>

  const { gpus, ...flat } = h
  const flatError = checkFields(flat, HW_SPEC, 'hw')
  if (flatError !== null) return flatError

  if (!Array.isArray(gpus)) return 'missing field: hw.gpus'
  for (const g of gpus) {
    const e = checkFields(g, { name: { kind: 'ident' }, vramMb: { kind: 'number' } }, 'hw.gpus[]')
    if (e !== null) return e
  }
  return null
}

/** Validate one event's `payload` against its spec. */
function validatePayload(eventName: string, payload: unknown): string | null {
  if (eventName === 'bench_result') {
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
      return 'bench_result requires an object payload'
    }
    const p = payload as Record<string, unknown>
    for (const key of Object.keys(p)) {
      if (!Object.prototype.hasOwnProperty.call(BENCH_PAYLOAD, key)) return `unknown field: payload.${key}`
    }
    for (const [block, spec] of Object.entries(BENCH_PAYLOAD)) {
      const e = checkFields(p[block], spec, `payload.${block}`)
      if (e !== null) return e
    }
    return null
  }

  const spec = PAYLOAD_SPECS[eventName]
  if (spec === undefined) {
    return payload === undefined ? null : `${eventName} takes no payload`
  }
  return checkFields(payload, spec, 'payload')
}

export type ValidationResult =
  | { ok: true; event: Record<string, unknown> }
  | { ok: false; reason: string }

/** Validate an untrusted event against the allow-list. Never throws. */
export function validateEvent(raw: unknown): ValidationResult {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, reason: 'event must be an object' }
  }
  const e = raw as Record<string, unknown>

  if (typeof e.event !== 'string' || !(EVENT_NAMES as readonly string[]).includes(e.event)) {
    return { ok: false, reason: `unknown event name: ${String(e.event)}` }
  }

  for (const key of Object.keys(e)) {
    if (!(ENVELOPE_KEYS as readonly string[]).includes(key)) {
      return { ok: false, reason: `unknown field: ${key}` }
    }
  }

  // Found in pre-release review: `schema` and `ts` were both allow-listed in
  // ENVELOPE_KEYS but never actually checked — any value, any size, on every
  // event including `consent_choice`, reached D1/PostHog verbatim. `schema`
  // applies to every event (checked here, before the consent_choice branch);
  // `ts` is checked further below, only on the non-consent_choice path — it is
  // already structurally BANNED on consent_choice by the loop just under this.
  if (e.schema !== TELEMETRY_SCHEMA_VERSION) {
    return { ok: false, reason: `invalid value for schema: ${String(e.schema)}` }
  }

  // `consent_choice` is the one event with a different envelope, and the
  // difference is the whole point of it (ADR-299 Decision 5): it is the only
  // event a machine that chose Off ever sends, so it must carry NOTHING that
  // could attribute it — no machineId, no hardware, no OS, no precise
  // timestamp. Enforced here rather than trusted to the caller, because a
  // regression that quietly attached a machineId would silently turn an
  // anonymous count into tracking of people who opted out.
  if (e.event === 'consent_choice') {
    for (const banned of ['machineId', 'app', 'hw', 'ts', 'payload']) {
      if (banned in e) return { ok: false, reason: `consent_choice must not carry ${banned}` }
    }
    if (typeof e.level !== 'string' || !(CONSENT_LEVELS as readonly string[]).includes(e.level)) {
      return { ok: false, reason: `invalid value for level: ${String(e.level)}` }
    }
    return { ok: true, event: e }
  }

  if ('level' in e) return { ok: false, reason: 'level is only valid on consent_choice' }

  // ISO-8601 as produced by `new Date().toISOString()` — the exact, only shape
  // any real caller ever constructs. Bounded and fully anchored, so nothing
  // else (an object, an oversized string, a malformed date) can pass.
  if (typeof e.ts !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(e.ts)) {
    return { ok: false, reason: 'missing or malformed field: ts' }
  }

  // A uuid and nothing else. The machineId is the only per-install identifier
  // we hold, so it must not be usable as a smuggling channel for anything the
  // client could otherwise be persuaded to put there.
  if (typeof e.machineId !== 'string' || !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(e.machineId)) {
    return { ok: false, reason: 'missing or malformed field: machineId' }
  }

  const appError = checkFields(e.app, { version: { kind: 'ident' }, os: { kind: 'os' } }, 'app')
  if (appError !== null) return { ok: false, reason: appError }

  if (e.event === 'bench_result') {
    const hwError = validateHw(e.hw)
    if (hwError !== null) return { ok: false, reason: hwError }
  } else if ('hw' in e) {
    return { ok: false, reason: 'hw is only valid on bench_result' }
  }

  const payloadError = validatePayload(e.event, e.payload)
  if (payloadError !== null) return { ok: false, reason: payloadError }

  return { ok: true, event: e }
}

export type SanityResult = { ok: true } | { ok: false; reason: string }

/** How deep `structuralSanityCheck`'s string scan will recurse before giving
 *  up and treating the value as unsafe. Every real event nests at most two
 *  levels (`payload.block.field`); this bounds a pathologically deep but
 *  small-total-size payload designed to dodge `MAX_EVENT_BYTES`. */
const MAX_SANITY_DEPTH = 6

/** True if any string anywhere in `v` exceeds `MAX_IDENT_LEN` — the SAME cap
 *  `isSafeIdent` already enforces for the six `bench_result` fields that are
 *  today's only free-text-shaped values, and the one this pipeline already
 *  trusts enough to forward to PostHog. No field in the current schema is
 *  ever valid above it, so this rejects nothing a real event would send —
 *  its only job is closing a hole `structuralSanityCheck` would otherwise
 *  leave open: an unrecognized field name (which it deliberately does not
 *  check, so real schema drift keeps working) is not a license for an
 *  unrecognized field VALUE of unbounded length. */
function hasOversizedString(v: unknown, depth = 0): boolean {
  if (depth > MAX_SANITY_DEPTH) return true
  if (typeof v === 'string') return v.length > MAX_IDENT_LEN
  if (Array.isArray(v)) return v.some((x) => hasOversizedString(x, depth + 1))
  if (v !== null && typeof v === 'object') return Object.values(v).some((x) => hasOversizedString(x, depth + 1))
  return false
}

/**
 * A coarser, permanent check — the shape of an event that must hold true
 * FOREVER, independent of `EVENT_NAMES`/`PAYLOAD_SPECS`/any enum in this file
 * (ADR-331, ADR-333). It exists to answer one question for the Worker: when
 * `validateEvent` rejects something, is that because the event is malformed
 * or hostile, or merely because this Worker's deployed schema snapshot is
 * older or newer than the client's (in which case it should be quarantined,
 * not destroyed — see `telemetry-worker/src/index.ts`)?
 *
 * ADR-331: the Worker inlines this file at deploy time, so its allow-list can
 * fall behind the client's by design (a schema change ships in the daemon
 * long before anyone remembers to `wrangler deploy`). `first_chat` and
 * `failReason` were both rejected for weeks by an out-of-date Worker and
 * silently destroyed. This function is deliberately narrower than
 * `validateEvent` — it does not know any event name, field name, or enum
 * value — so it keeps working unmodified no matter how the schema evolves,
 * and a real future event always passes it.
 *
 * Two invariants enforced here are hard rejects, never quarantine-eligible,
 * because a quarantine table is still our own storage:
 *  - `consent_choice` must carry nothing attributable (ADR-299 Decision 5).
 *    Quarantining a violation would still turn an anonymous opt-out ping into
 *    an attributable record, defeating the entire point of the event.
 *  - No string anywhere may exceed `MAX_IDENT_LEN` (`hasOversizedString`
 *    above) — otherwise an unrecognized field name would be a free pass for
 *    an unbounded-length value, including a real one accidentally attached
 *    by a client bug rather than a hostile request.
 */
export function structuralSanityCheck(raw: unknown): SanityResult {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, reason: 'event must be an object' }
  }
  const e = raw as Record<string, unknown>

  if (typeof e.event !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/.test(e.event)) {
    return { ok: false, reason: 'event name must be a short lowercase identifier' }
  }

  if (e.event === 'consent_choice') {
    for (const banned of ['machineId', 'app', 'hw', 'ts', 'payload']) {
      if (banned in e) return { ok: false, reason: `consent_choice must not carry ${banned}` }
    }
  }

  if (hasOversizedString(e)) {
    return { ok: false, reason: 'a string value is too long to be a quarantine candidate' }
  }

  return { ok: true }
}
