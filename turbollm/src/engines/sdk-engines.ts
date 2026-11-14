// The daemon's read of the in-app TurboLLM SDK's engine catalog (ADR-462, architecture §2.4/§3.3). The Android
// reconciler reads it once per start to decide which SDK rows exist; an unreadable list must never fail the boot, so
// every failure is null, which the reconciler reads as "change nothing".
import { TURBOLLM_SDK_KIND, type ModelFormat } from './compat'
import { engineRequestHeaders } from './engine-headers'

export interface SdkEngineInfo {
  id: string
  name: string
  kind: string
  formats: ModelFormat[]
  backends: Array<'cpu' | 'gpu'>
  available: boolean
  reason?: string
}

const SDK_ENGINES_PATH = '/sdk/v1/engines'
const READ_BUDGET_MS = 5000
const KNOWN_FORMATS: ReadonlySet<string> = new Set<ModelFormat>(['gguf', 'mlx', 'litertlm'])
const KNOWN_BACKENDS: ReadonlySet<string> = new Set(['cpu', 'gpu'])

/** GET {baseUrl}/sdk/v1/engines with the SDK bearer, within 5 s. null on any failure: transport, non-2xx, or a body
 *  that does not parse. Unknown formats are dropped from an entry, and an entry left with no known format is dropped. */
export async function readSdkEngines(
  baseUrl: string,
  env: NodeJS.ProcessEnv = process.env,
  fetchFn: typeof fetch = fetch,
): Promise<SdkEngineInfo[] | null> {
  try {
    const res = await fetchFn(`${baseUrl}${SDK_ENGINES_PATH}`, {
      headers: engineRequestHeaders(TURBOLLM_SDK_KIND, new Headers(), env),
      signal: AbortSignal.timeout(READ_BUDGET_MS),
    })
    if (!res.ok) return null
    return engineCatalog(await res.json())
  } catch {
    return null
  }
}

function engineCatalog(body: unknown): SdkEngineInfo[] | null {
  const data = (body as { data?: unknown } | null)?.data
  if (!Array.isArray(data)) return null
  return data.flatMap((entry) => {
    const info = engineInfo(entry)
    return info ? [info] : []
  })
}

function engineInfo(entry: unknown): SdkEngineInfo | undefined {
  if (!isEngineEntry(entry)) return undefined
  const formats = stringsIn(entry.formats, KNOWN_FORMATS) as ModelFormat[]
  if (formats.length === 0) return undefined
  const backends = stringsIn(entry.backends, KNOWN_BACKENDS) as Array<'cpu' | 'gpu'>
  const { id, name, kind, available, reason } = entry
  return { id, name, kind, formats, backends, available, ...(typeof reason === 'string' ? { reason } : {}) }
}

type EngineEntry = Omit<SdkEngineInfo, 'formats' | 'backends' | 'reason'> & {
  formats?: unknown
  backends?: unknown
  reason?: unknown
}

function isEngineEntry(entry: unknown): entry is EngineEntry {
  if (typeof entry !== 'object' || entry === null) return false
  const { id, name, kind, available } = entry as Partial<EngineEntry>
  return typeof id === 'string' && id !== '' && typeof name === 'string' && typeof kind === 'string'
    && typeof available === 'boolean'
}

function stringsIn(values: unknown, known: ReadonlySet<string>): string[] {
  return Array.isArray(values) ? values.filter((v): v is string => typeof v === 'string' && known.has(v)) : []
}
