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

export interface LoadError {
  code?: string
  message?: string
  logTail?: string[]
}

/** Substrings that mean "we ran out of memory", across the backends we ship.
 *  Lowercased before matching. */
const OOM_SIGNS = [
  'out of memory',
  'outofmemory',
  'failed to allocate',
  'alloc_buffer',
  'memory allocation of size',
  'cudamalloc',
  'insufficient memory',
]

const ARCH_SIGNS = ['unknown model architecture', 'unsupported model architecture', 'unsupported architecture']

const GGUF_SIGNS = ['invalid magic', 'error loading model', 'failed to load model', 'gguf_init', 'corrupt']

/** Classify a load failure. Never throws; never returns anything but an enum
 *  member. */
export function classifyLoadFailure(err: LoadError | null | undefined): string {
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
export function classifyBenchFailure(results: readonly BenchProbeOutcome[]): string {
  if (results.some((r) => r.outcome === 'oom')) return 'oom'
  if (results.some((r) => r.outcome === 'timeout')) return 'timeout'
  return 'other'
}
