/**
 * Telemetry event schema — the single source of truth for what may be sent
 * (ADR-299 Decision 6, `architecture/08-telemetry-and-consent.md`).
 *
 * As of spec 24 (ADR-333) this file is an ASSEMBLY layer, not where events
 * are defined. Every event lives in `events/*.ts` as a `defineEvent()` call;
 * this file wires the resulting registry into the one `validateEvent`
 * function the Worker and the client both import, and re-exports the small
 * set of names other modules in this codebase already depend on so nothing
 * outside `telemetry/` needed an import-path change for this redesign.
 *
 * This module is deliberately dependency-free so the Cloudflare Worker can
 * import `validateEvent` verbatim: the allow-list must never drift between the
 * client that emits and the edge that ingests, or the privacy claim and the
 * abuse filter stop agreeing with each other.
 *
 * The load-bearing rule (ADR-299): **every field is an enum defined here, and
 * there are no free-form strings.** That one rule is simultaneously the privacy
 * guarantee (a prompt or a path cannot be expressed), the cardinality control,
 * and the primary anti-abuse filter. Enforced by the type system now
 * (`core/types.ts` has no `string` field kind), not only by convention.
 */

import { checkFields, structuralSanityCheck as coreStructuralSanityCheck, validateExtraBlock, validatePayload } from './core/validate'
import { f } from './core/define'
import type { EventDef } from './core/types'
import { CONSENT_LEVELS, ERROR_FINGERPRINTS, FAIL_REASONS, ONBOARDING_STEPS, OUTCOMES, PROVISION_FAIL_REASONS } from './core/enums'
import { EVENT_NAMES, REGISTRY, type EventName } from './events/index'

/** Wire-format version. Bump only for a breaking payload change. */
export const TELEMETRY_SCHEMA_VERSION = 1

export type { EventName }
export { EVENT_NAMES, REGISTRY }

// Re-exported for the handful of enums other telemetry modules import
// directly (classify.ts's tests, event definitions elsewhere). The
// authoritative source is `core/enums.ts` — see it for the full list this
// file doesn't need to re-export because nothing outside `events/*.ts`
// references them.
export { CONSENT_LEVELS, ERROR_FINGERPRINTS, FAIL_REASONS, ONBOARDING_STEPS, OUTCOMES, PROVISION_FAIL_REASONS }

export { MAX_IDENT_LEN } from './core/validate'

/** The only keys that may appear at the top level of any event. An unknown key
 *  is a hard reject rather than something we strip: silently dropping it would
 *  hide a caller that thinks it is sending data we never store. */
export const ENVELOPE_KEYS = ['schema', 'event', 'ts', 'machineId', 'app', 'hw', 'payload', 'level'] as const

export type ValidationResult = { ok: true; event: Record<string, unknown> } | { ok: false; reason: string }

/** Validate an untrusted event against the allow-list. Never throws. */
export function validateEvent(raw: unknown): ValidationResult {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, reason: 'event must be an object' }
  }
  const e = raw as Record<string, unknown>

  if (typeof e.event !== 'string' || !(EVENT_NAMES as readonly string[]).includes(e.event)) {
    return { ok: false, reason: `unknown event name: ${String(e.event)}` }
  }
  const def: EventDef = REGISTRY[e.event as EventName]

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

  const appError = checkFields(e.app, { version: f.ident(), os: f.os() }, 'app')
  if (appError !== null) return { ok: false, reason: appError }

  if (def.extraEnvelopeBlock !== undefined) {
    const blockError = validateExtraBlock(def, e[def.extraEnvelopeBlock.key])
    if (blockError !== null) return { ok: false, reason: blockError }
  } else if ('hw' in e) {
    return { ok: false, reason: 'hw is only valid on bench_result' }
  }

  const payloadError = validatePayload(def, e.payload)
  if (payloadError !== null) return { ok: false, reason: payloadError }

  return { ok: true, event: e }
}

export type { SanityResult } from './core/validate'

/** See `core/validate.ts` for the full rationale. Re-exported here because
 *  `ingest.ts` (and the Worker, which imports it verbatim) reach for this
 *  module by convention — this is the one file both sides have always
 *  imported the shared allow-list from. */
export const structuralSanityCheck = coreStructuralSanityCheck
