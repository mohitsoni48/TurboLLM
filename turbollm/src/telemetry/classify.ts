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
