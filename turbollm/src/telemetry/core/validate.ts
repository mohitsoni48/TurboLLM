/**
 * The generic, registry-driven validator (spec 24, ADR-333) — replaces the
 * hand-written `checkFields`/`validatePayload`/`validateHw` trio in the
 * original `schema.ts` with ONE function that walks whatever `FieldSpec`
 * shape a `defineEvent()` declares, including recursing into nested
 * `object`/`array` blocks. Adding a nested-shape event (the way
 * `bench_result`'s `hw.gpus[]` needed a bespoke `validateHw` before) no
 * longer needs a new validator function — it needs a `defineEvent` shape.
 *
 * Every message this produces is a byte-for-byte match of the original
 * hand-written validator for every case the original test suite exercises —
 * verified by running that entire suite, unmodified, against this file
 * (spec 24 §8 Phase 1's required equivalence proof) before anything else in
 * this redesign was allowed to build on top of it.
 */

import type { EventDef, FieldSpec } from './types'

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
 * own runtime introspection, not from a hardware string or a file.
 *
 * Scoped narrowly rather than loosening `isSafeIdent` itself: exactly one slash
 * between two short lowercase-alnum tokens. A real filesystem path (multiple
 * segments, dots, drive letters, backslashes) cannot pass this.
 */
function isSafeOs(v: unknown): boolean {
  return typeof v === 'string' && /^[a-z0-9]{1,32}\/[a-z0-9]{1,32}$/.test(v)
}

/** Check a flat-or-nested object against a field spec. Returns an error
 *  string or null. `path` is used only to build a readable rejection reason,
 *  and is threaded into recursive `object`/`array` calls so a deeply nested
 *  failure still reads as e.g. `payload.model.name`. */
export function checkFields(obj: unknown, spec: Record<string, FieldSpec>, path: string): string | null {
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
    return `${path} must be an object`
  }
  const o = obj as Record<string, unknown>

  // Object.prototype.hasOwnProperty, NOT `key in spec` — `in` walks the
  // prototype chain, so 'toString'/'constructor'/'valueOf' etc. would pass
  // as "known fields" here and then never be validated at all, since the
  // loop below only iterates the spec's OWN entries (found in pre-release
  // review). `spec` is always our own literal object, so this call can never
  // itself fail on a missing hasOwnProperty.
  for (const key of Object.keys(o)) {
    if (!Object.prototype.hasOwnProperty.call(spec, key)) return `unknown field: ${path}.${key}`
  }

  for (const [key, field] of Object.entries(spec)) {
    const v = o[key]
    const where = `${path}.${key}`

    if (v === undefined) {
      if (field.optional) continue
      return `missing field: ${where}`
    }
    if (v === null && field.kind !== 'enum' && 'nullable' in field && field.nullable) continue

    if (field.kind === 'enum') {
      if (typeof v !== 'string' || !field.values.includes(v)) return `invalid value for ${where}: ${String(v)}`
    } else if (field.kind === 'ident') {
      if (!isSafeIdent(v)) return `invalid value for ${where}`
    } else if (field.kind === 'os') {
      if (!isSafeOs(v)) return `invalid value for ${where}`
    } else if (field.kind === 'number') {
      if (typeof v !== 'number' || !Number.isFinite(v)) return `invalid value for ${where}: ${String(v)}`
      if (field.min !== undefined && v < field.min) return `invalid value for ${where}: ${String(v)}`
      if (field.max !== undefined && v > field.max) return `invalid value for ${where}: ${String(v)}`
    } else if (field.kind === 'boolean') {
      if (typeof v !== 'boolean') return `invalid value for ${where}: ${String(v)}`
    } else if (field.kind === 'object') {
      const e = checkFields(v, field.shape, where)
      if (e !== null) return e
    } else if (field.kind === 'array') {
      if (!Array.isArray(v)) return `missing field: ${where}`
      for (const item of v) {
        const e = checkFields(item, itemSpecAsObjectShape(field.items), `${where}[]`)
        if (e !== null) return e
      }
    }
  }
  return null
}

/** `checkFields` validates one object's fields against a `Record<string,
 *  FieldSpec>` shape; an array's `items` spec is a single `FieldSpec` (e.g.
 *  `f.object({...})`), not already a field map. Every real use today is an
 *  array of objects (`hw.gpus[]`), so this unwraps that one shape rather
 *  than adding a second, array-specific recursion path. */
function itemSpecAsObjectShape(items: FieldSpec): Record<string, FieldSpec> {
  if (items.kind === 'object') return items.shape
  throw new Error(`array items of kind '${items.kind}' are not supported yet — only 'object' items exist today`)
}

/** Validate one event's `payload` (and, if the event's definition declares
 *  one, its extra envelope block) against its registered spec. */
export function validatePayload(def: EventDef, payload: unknown): string | null {
  if (def.payload === undefined) {
    return payload === undefined ? null : `${def.name} takes no payload`
  }
  return checkFields(payload, def.payload, 'payload')
}

/** Validate the extra envelope block (today: only `bench_result`'s `hw`). */
export function validateExtraBlock(def: EventDef, value: unknown): string | null {
  if (def.extraEnvelopeBlock === undefined) return null
  return checkFields(value, def.extraEnvelopeBlock.shape, def.extraEnvelopeBlock.key)
}

export type SanityResult = { ok: true } | { ok: false; reason: string }

/** How deep `structuralSanityCheck`'s string scan will recurse before giving
 *  up and treating the value as unsafe. Every real event nests at most two
 *  levels (`payload.block.field`); this bounds a pathologically deep but
 *  small-total-size payload designed to dodge the ingest size cap. */
const MAX_SANITY_DEPTH = 6

/** True if any string anywhere in `v` exceeds `MAX_IDENT_LEN` — the SAME cap
 *  `isSafeIdent` already enforces for the six `bench_result` fields that are
 *  today's only free-text-shaped values, and the one this pipeline already
 *  trusts enough to forward to PostHog. No field in the registry is ever
 *  valid above it, so this rejects nothing a real event would send — its
 *  only job is closing a hole `structuralSanityCheck` would otherwise leave
 *  open: an unrecognized field name (which it deliberately does not check,
 *  so real schema drift keeps working) is not a license for an unrecognized
 *  field VALUE of unbounded length. */
function hasOversizedString(v: unknown, depth = 0): boolean {
  if (depth > MAX_SANITY_DEPTH) return true
  if (typeof v === 'string') return v.length > MAX_IDENT_LEN
  if (Array.isArray(v)) return v.some((x) => hasOversizedString(x, depth + 1))
  if (v !== null && typeof v === 'object') return Object.values(v).some((x) => hasOversizedString(x, depth + 1))
  return false
}

/**
 * A coarser, permanent check — the shape of an event that must hold true
 * FOREVER, independent of the registry or any enum in it (ADR-331, ADR-333).
 * It exists to answer one question for the Worker: when the full validator
 * rejects something, is that because the event is malformed or hostile, or
 * merely because this Worker's deployed schema snapshot is older or newer
 * than the client's (in which case it should be quarantined, not destroyed
 * — see `telemetry-worker/src/index.ts`)?
 *
 * ADR-331: the Worker inlines the telemetry module at deploy time, so its
 * allow-list can fall behind the client's by design (a schema change ships
 * in the daemon long before anyone remembers to `wrangler deploy`).
 * `first_chat` and `failReason` were both rejected for weeks by an
 * out-of-date Worker and silently destroyed. This function is deliberately
 * narrower than the full validator — it does not know any event name, field
 * name, or enum value — so it keeps working unmodified no matter how the
 * registry evolves, and a real future event always passes it.
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
