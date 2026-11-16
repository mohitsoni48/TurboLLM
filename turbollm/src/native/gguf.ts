// The daemon's GGUF API on top of the native core (arch 5.4, B-3): the only seam callers use.
import type { GgufMeta } from './binding.generated'
import { loadCore } from './load'

export type { GgufMeta } from './binding.generated'

export type GgufErrorCode = 'not_gguf' | 'bad_version' | 'truncated' | 'bad_type' | 'too_large'

const GGUF_ERROR_CODES: ReadonlySet<string> = new Set<GgufErrorCode>([
  'not_gguf',
  'bad_version',
  'truncated',
  'bad_type',
  'too_large',
])
const UNKNOWN_QUANT = '?'

export class GgufError extends Error {
  constructor(
    public readonly code: GgufErrorCode,
    msg: string,
  ) {
    super(msg)
    this.name = 'GgufError'
  }
}

export const MAX_ASYNC_HEADER_READ = 256 * 1024 * 1024

/** Rejects with a GgufError for a file that is not a readable GGUF header, or a plain Error for an I/O failure. */
export function parseGgufAsync(path: string, maxRead = MAX_ASYNC_HEADER_READ): Promise<GgufMeta> {
  return loadCore().parseGguf(path, maxRead).catch(rethrowAsFacadeError)
}

/** Whether a file of `size` bytes ends before the data its header declares. */
export function ggufCutShort(path: string, size: number): Promise<boolean> {
  return loadCore().ggufCutShort(path, size)
}

export function quantFromName(fileName: string): string {
  return loadCore().quantFromName(fileName) ?? UNKNOWN_QUANT
}

function rethrowAsFacadeError(error: unknown): never {
  if (!(error instanceof Error)) throw error
  const code = (error as Error & { code?: unknown }).code
  if (isGgufErrorCode(code)) throw new GgufError(code, error.message)
  if (code === 'io') throw new Error(error.message, { cause: error })
  throw error
}

function isGgufErrorCode(code: unknown): code is GgufErrorCode {
  return typeof code === 'string' && GGUF_ERROR_CODES.has(code)
}
