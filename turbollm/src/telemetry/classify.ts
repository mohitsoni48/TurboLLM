/**
 * Turns an engine load failure into one of the `FAIL_REASONS` enum values
 * (ADR-299 Decision 6).
 *
 * This is the boundary where the "never send log text" rule is actually
 * enforced. Engine errors carry paths, model file names and driver strings in
 * `message`/`logTail`; none of that may leave the machine. The input is raw
 * text, the output is always an enum member — including for inputs we do not
 * recognise, which become `other` rather than anything derived from the text.
 *
 * Matching order matters. Real llama.cpp OOM output contains BOTH
 * "error loading model" and an allocation failure, so a naive top-down scan
 * reports it as `bad_gguf` and sends us hunting a corruption bug that does not
 * exist. OOM is therefore checked first.
 */

import type { FAIL_REASONS, PROVISION_FAIL_REASONS } from './core/enums'
import type { HARNESSES } from './events/gateway'

type FailReason = (typeof FAIL_REASONS)[number]
type Harness = (typeof HARNESSES)[number]
type ProvisionFailReason = (typeof PROVISION_FAIL_REASONS)[number]

export interface LoadError {
  code?: string
  message?: string
  logTail?: string[]
}

/** Substrings that mean "we ran out of memory", across the backends we ship.
 *  Lowercased before matching. Widened (telemetry-review follow-up) with more
 *  vendor/runtime phrasings — `failReason: 'other'` was absorbing half of all
 *  real failures, and these are legitimate, well-known error strings for the
 *  backends this product actually ships, not guesses. */
const OOM_SIGNS = [
  'out of memory',
  'outofmemory',
  'failed to allocate',
  'alloc_buffer',
  'memory allocation of size',
  'cudamalloc',
  'insufficient memory',
  'not enough memory',
  'unable to allocate',
  'bad_alloc',
  'out of vram',
  'vram allocation failed',
  'cuda_error_out_of_memory',
  'resource_exhausted',
]

const ARCH_SIGNS = [
  'unknown model architecture',
  'unsupported model architecture',
  'unsupported architecture',
  'architecture not supported',
  'unknown architecture',
]

/** Corruption/truncation signs — includes an incomplete or interrupted
 *  download, which manifests as a gguf that fails to parse the same way a
 *  genuinely corrupt one does. */
const GGUF_SIGNS = [
  'invalid magic',
  'error loading model',
  'failed to load model',
  'gguf_init',
  'corrupt',
  'unexpected end of file',
  'unexpectedly reached end of file',
  'truncated',
  'failed to read tensor',
  'wrong number of tensors',
  'tensor not found',
]

/** Classify a load failure. Never throws; never returns anything but an enum
 *  member. */
export function classifyLoadFailure(err: LoadError | null | undefined): FailReason {
  if (!err) return 'other'

  // Structured codes are trustworthy — prefer them over text sniffing, except
  // for the generic wrappers ('load_failed'/'model_load_failed') which say only
  // that something went wrong.
  if (err.code === 'readiness_timeout') return 'timeout'
  if (err.code === 'engine_unsupported') return 'no_engine'

  const haystack = [err.message ?? '', ...(err.logTail ?? [])].join('\n').toLowerCase()

  if (haystack.includes('no_active_engine')) return 'no_engine'
  if (haystack.includes('no_such_model')) return 'bad_gguf'

  // Order is load-bearing — see the module comment.
  if (OOM_SIGNS.some((s) => haystack.includes(s))) return 'oom'
  if (ARCH_SIGNS.some((s) => haystack.includes(s))) return 'unsupported_arch'
  if (GGUF_SIGNS.some((s) => haystack.includes(s))) return 'bad_gguf'

  return 'other'
}

/** One internal auto-tune search probe's outcome (a subset of
 *  `BenchCandidate['outcome']` — only the fields this classifier needs, so
 *  bench.ts's real candidate objects satisfy this structurally). */
export interface BenchProbeOutcome {
  outcome: 'ok' | 'timeout' | 'crash' | 'oom'
}

/**
 * Classify why an auto-tune sweep ended without a usable profile.
 *
 * Distinct from {@link classifyLoadFailure} because bench.ts's failure signal
 * is not one error — it is the AGGREGATE of several internal search probes
 * (VRAM probe, t/s trial, card-sampling), each of which is individually
 * *expected* to fail sometimes as part of normal binary search. There is no
 * single raw error to run through the text-sniffing classifier above; there is
 * only "here is what every attempted candidate did."
 *
 * OOM wins if present at all, matching the same precedence philosophy as
 * `classifyLoadFailure`: it is the most actionable explanation, and a sweep
 * that hit OOM on some candidates before running out of options is honestly
 * described as memory-bound even if a couple of attempts merely timed out or
 * crashed along the way.
 */
export function classifyBenchFailure(results: readonly BenchProbeOutcome[]): 'oom' | 'timeout' | 'other' {
  if (results.some((r) => r.outcome === 'oom')) return 'oom'
  if (results.some((r) => r.outcome === 'timeout')) return 'timeout'
  return 'other'
}

/**
 * Classify an engine failure into an `ERROR_FINGERPRINTS` member (`error`
 * event, ADR-299 Decision 6 / the telemetry-review follow-up that added it).
 *
 * Distinct purpose from {@link classifyLoadFailure}: that function feeds the
 * once-ever `model_first_load` milestone; this one feeds the ongoing `error`
 * event, which is meant to fire every time an engine dies, not just on an
 * install's first attempt. Reuses the same sign lists so the two classifiers
 * cannot silently drift into disagreeing about what an OOM message looks like.
 *
 * `engine_crash` is the deliberate fallback for `engine_exited`/
 * `engine_spawn_failed` codes with no more specific signal recognised — we DO
 * know structurally that the process died, so `other` would under-describe it.
 */
export function classifyEngineErrorFingerprint(err: LoadError | null | undefined): string {
  if (!err) return 'other'

  if (err.code === 'readiness_timeout') return 'engine_start_timeout'
  if (err.code === 'model_load_failed') return 'model_load_failed'

  const haystack = [err.message ?? '', ...(err.logTail ?? [])].join('\n').toLowerCase()

  if (OOM_SIGNS.some((s) => haystack.includes(s))) return 'cuda_oom'
  if (ARCH_SIGNS.some((s) => haystack.includes(s))) return 'model_load_failed'
  if (GGUF_SIGNS.some((s) => haystack.includes(s))) return 'model_load_failed'

  if (err.code === 'engine_exited' || err.code === 'engine_spawn_failed') return 'engine_crash'
  return 'other'
}

/** Substrings for provisioning (engine install) failures — a download/extract
 *  of a prebuilt binary, distinct from both a model load and a from-source
 *  build. Lowercased before matching. */
const NETWORK_SIGNS = [
  'enotfound', 'econnreset', 'econnrefused', 'etimedout', 'fetch failed',
  'network', 'check your connection',
]
const NO_ASSET_SIGNS = ['404', 'no downloadable binary', 'no release asset', 'not found in']
const UNSUPPORTED_PLATFORM_SIGNS = ['no prebuilt binary for this operating system', 'unsupported platform', 'unsupported architecture']
const DISK_FULL_SIGNS = ['enospc', 'no space left']
const PERMISSION_SIGNS = ['eacces', 'eperm', 'permission denied', 'access is denied']

/**
 * Classify a gateway request's client into the closed `HARNESSES` enum (spec 23
 * §3.5), from its `User-Agent` header. Never throws; never returns anything but
 * an enum member — the raw header string itself is never sent anywhere
 * (ADR-299 Decision 6's "never send free text" rule applies here exactly as it
 * does to every other classifier in this file).
 *
 * `claude_code` is the one mapping confirmed against real behaviour: Claude
 * Code's CLI sends `claude-cli/x.y.z` (spec 23 §3.5). Every other mapping below
 * is a best-effort substring match against each tool's own package/binary name
 * — plausible, but NOT verified against a live install (spec 23 Gap C: a
 * planned static-binary scan didn't complete). `unknown`/`other` are the
 * deliberately safe defaults rather than a guess dressed up as certainty — per
 * the spec's own fallback plan, real-world `harness_first_seen{unknown}`
 * volume is what should drive refining this list next, not more guessing now.
 *
 * Order matters only where one tool's name could appear inside another's UA
 * string; kept specific-before-generic (e.g. `vscode` last) for that reason.
 */
export function classifyHarness(userAgent: string | null | undefined): Harness {
  if (!userAgent) return 'unknown'
  const ua = userAgent.toLowerCase()

  if (ua.startsWith('claude-cli/') || ua.includes('claude-code')) return 'claude_code'
  if (ua.includes('opencode')) return 'opencode'
  if (ua.includes('kilocode') || ua.includes('kilo-code')) return 'kilo'
  if (ua.includes('hermes-agent')) return 'hermes'
  if (ua.includes('openclaw')) return 'openclaw'
  if (ua.includes('pi-coding-agent') || ua.includes('earendil')) return 'pi'
  if (ua.includes('continue-dev') || ua.includes('continuedev')) return 'continue'
  if (ua.includes('cline')) return 'cline'
  if (ua.includes('roo-code') || ua.includes('roocode')) return 'roo'
  if (ua.includes('cursor')) return 'cursor'
  // aider shells out through the `litellm` Python package, whose default
  // client User-Agent is `litellm/x.y.z` — a real, documented signature of
  // that library rather than a guess at aider's own UA.
  if (ua.includes('aider') || ua.includes('litellm')) return 'aider'
  if (ua.includes('zed')) return 'zed'
  if (ua.includes('vscode')) return 'vscode'

  return 'other'
}

/**
 * Classify why provisioning a prebuilt engine failed, into a
 * `PROVISION_FAIL_REASONS` member (the `engine_installed` event, spec 23 §4 —
 * promoted out of `onboarding_step: engine_install`, ADR-299 amended by the
 * telemetry-review follow-up).
 *
 * Mirrors {@link classifyLoadFailure}'s boundary contract exactly: the input
 * is `ProvisionState.fail()`'s free-form message (built from `Error#message`
 * at call sites across `api/routes.ts`/`engines/seed.ts`/`engines/update-
 * apply.ts`), the output is always an enum member, and classification happens
 * INSIDE `ProvisionState` — never the raw string — so `onSettled` observers
 * (telemetry included) still never see free text, preserving the invariant
 * both `ProvisionState` and `BuildState` document on `onSettled`.
 */
export function classifyProvisionFailure(message: string | null | undefined): ProvisionFailReason {
  if (!message) return 'other'
  const haystack = message.toLowerCase()

  if (UNSUPPORTED_PLATFORM_SIGNS.some((s) => haystack.includes(s))) return 'unsupported_platform'
  if (NO_ASSET_SIGNS.some((s) => haystack.includes(s))) return 'no_asset'
  if (DISK_FULL_SIGNS.some((s) => haystack.includes(s))) return 'disk_full'
  if (PERMISSION_SIGNS.some((s) => haystack.includes(s))) return 'permission_denied'
  if (NETWORK_SIGNS.some((s) => haystack.includes(s))) return 'network'

  return 'other'
}
