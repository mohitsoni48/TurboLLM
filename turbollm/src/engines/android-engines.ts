// The Android app's engine rows (ADR-462, architecture §3.4): one row per engine the in-app TurboLLM SDK reports, the
// spawned engines the APK ships in nativeLibraryDir, and the one settings copy between them. planAndroidEngines is a
// pure planner over the rows, the remembered retired rows, the shipped files and the SDK's engine list.
import { basename } from 'node:path'
import type { Engine, LastLoaded } from '../config/config'
import type { ModelFormat } from './compat'
import { LITERT_LM_NATIVE_SERVER } from './litert-lm'
import type { SdkEngineInfo } from './sdk-engines'

/** Fixed identity for the CPU llama.cpp server the Android app ships and registers for itself. There is no "add engine"
 *  UI in the app shell, so matching on this exact name (and the bundled file) finds "the engine the app owns" across
 *  restarts without persisting a separate id anywhere. */
export const ANDROID_ENGINE_NAME = 'llama-server-android'

/** The optional second spawned engine: the same llama.cpp server built with the Vulkan backend, so the GPU can be tried
 *  on devices whose driver supports it.
 *
 *  It is a SEPARATE, statically-linked binary rather than extra backend .so files next to the CPU engine, and that is
 *  not a packaging preference — it is forced twice over. `nativeLibraryDir` is flat, so a shared Vulkan build's
 *  libggml.so/libllama.so would collide with the CPU engine's under identical names. And measured on a Galaxy S21 FE
 *  (Mali-G78): with `libggml-vulkan.so` merely PRESENT in that directory, llama-server died during load_model even at
 *  `-ngl 0`, while moving that one file aside let the identical binary load and serve in ~2s. Two self-contained
 *  binaries keep a flaky GPU driver's blast radius to whichever engine the user selected.
 *
 *  Registered only when the file is actually in the APK. */
export const ANDROID_VULKAN_ENGINE_NAME = 'llama-server-android-vulkan'

/** The app's bundled LiteRT-LM server: the native port of `litert-lm serve` (litert-lm.ts, LITERT_LM_NATIVE_SERVER).
 *  Registered only when the APK carries it. The default build no longer does: the SDK's LiteRT-LM engine replaces it,
 *  and its settings are copied there once (ADR-462). */
export const ANDROID_LITERT_LM_ENGINE_NAME = 'litert-lm-android'

/** The spawned engines the APK may ship in nativeLibraryDir, by the name each is registered under, in the order the
 *  planner prefers them. */
export const ANDROID_BUNDLED_ENGINES: { name: string; file: string; kind: 'llama-server' | 'litert-lm' }[] = [
  { name: ANDROID_ENGINE_NAME, file: 'libllama_server.so', kind: 'llama-server' },
  { name: ANDROID_VULKAN_ENGINE_NAME, file: 'libllama_server_vk.so', kind: 'llama-server' },
  { name: ANDROID_LITERT_LM_ENGINE_NAME, file: LITERT_LM_NATIVE_SERVER, kind: 'litert-lm' },
]

/** The SDK engine whose row receives the one settings copy. */
const SDK_LITERT_ENGINE_ID = 'litert-lm'
const TURBOLLM_SDK_KIND = 'turbollm-sdk'

export interface AndroidEngineInput {
  engines: Engine[]
  activeEngineId: string
  lastLoaded: LastLoaded
  /** cfg.androidRetiredEngines */
  retired: Record<string, Engine & { copiedTo?: string }>
  /** Which ANDROID_BUNDLED_ENGINES files exist in nativeLibraryDir. */
  nativeLibFiles: ReadonlySet<string>
  /** null: the app did not start the SDK this launch. `engines` null: its list could not be read. */
  sdk: { baseUrl: string; engines: SdkEngineInfo[] | null } | null
  /** From the boot scan. */
  formatOf: (modelKey: string) => ModelFormat | undefined
}

/** `copy-state` names its target by SDK engine id: a new row's id exists only once the applier has upserted it. */
export type AndroidEngineAction =
  | { kind: 'upsert-sdk'; info: SdkEngineInfo; adoptLegacy: boolean }
  | { kind: 'repair-sdk-url'; baseUrl: string }
  | { kind: 'register-bundled' | 'repair-bundled'; name: string; file: string }
  | { kind: 'reinstate-bundled'; name: string; file: string }
  | { kind: 'retire'; engineId: string; remember: boolean }
  | { kind: 'copy-state'; from: string; to: string; format: ModelFormat }
  | { kind: 'activate'; engineId: string }

/** What the reconciler does this start, in order: SDK rows (rule 1), spawned rows (rule 2), the one copy (rule 3). */
export function planAndroidEngines(input: AndroidEngineInput): AndroidEngineAction[] {
  const rows = [...planSdkRows(input), ...planBundledRows(input)]
  return [...rows, ...planCopies(input, rows)]
}

/** Rule 1: one upsert per available SDK engine, the first reading GGUF adopting the M1 row; an SDK row whose engine is
 *  no longer available is retired. An unreadable list only repairs the URL: nothing is registered or retired on a
 *  guess. */
function planSdkRows({ sdk, engines }: AndroidEngineInput): AndroidEngineAction[] {
  if (!sdk) return []
  if (!sdk.engines) return [{ kind: 'repair-sdk-url', baseUrl: sdk.baseUrl }]
  const available = sdk.engines.filter((info) => info.available)
  const adopter = available.find((info) => info.formats.includes('gguf'))
  const upserts: AndroidEngineAction[] = available.map((info) => ({ kind: 'upsert-sdk', info, adoptLegacy: info === adopter }))
  const availableIds = new Set(available.map((info) => info.id))
  const retires: AndroidEngineAction[] = engines
    .filter((e) => e.kind === TURBOLLM_SDK_KIND && e.sdkEngine && !availableIds.has(e.sdkEngine.id))
    .map((e) => ({ kind: 'retire', engineId: e.id, remember: false }))
  return [...upserts, ...retires]
}

/** Rule 2: a shipped file is repaired, reinstated under its remembered id, or registered; the app's own row for a file
 *  this APK does not ship is retired and remembered. No settings move between rows. */
function planBundledRows({ engines, retired, nativeLibFiles }: AndroidEngineInput): AndroidEngineAction[] {
  return ANDROID_BUNDLED_ENGINES.flatMap(({ name, file }): AndroidEngineAction[] => {
    const own = ownBundledRow(engines, name, file)
    if (!nativeLibFiles.has(file)) return own ? [{ kind: 'retire', engineId: own.id, remember: true }] : []
    if (own) return [{ kind: 'repair-bundled', name, file }]
    if (retired[name]) return [{ kind: 'reinstate-bundled', name, file }]
    return [{ kind: 'register-bundled', name, file }]
  })
}

/** Rule 3: the bundled LiteRT-LM server's `.litertlm` settings, and the M1 row's, are copied onto the SDK's LiteRT-LM
 *  row, once. A copy, so the source keeps them for a rollback build. */
function planCopies(input: AndroidEngineInput, rows: AndroidEngineAction[]): AndroidEngineAction[] {
  if (!sdkEngineAvailable(input, SDK_LITERT_ENGINE_ID)) return []
  return [litertServerSource(input, rows), adoptedLegacySource(input, rows)]
    .filter((from): from is string => from !== undefined)
    .map((from) => ({ kind: 'copy-state', from, to: SDK_LITERT_ENGINE_ID, format: 'litertlm' }))
}

/** The litert-lm-android row whose settings still need the copy: retired by this plan, or remembered and not copied. */
function litertServerSource({ engines, retired }: AndroidEngineInput, rows: AndroidEngineAction[]): string | undefined {
  const own = ownBundledRow(engines, ANDROID_LITERT_LM_ENGINE_NAME, LITERT_LM_NATIVE_SERVER)
  if (own && isRetiredBy(rows, own.id)) return own.id
  const remembered = retired[ANDROID_LITERT_LM_ENGINE_NAME]
  return remembered && remembered.copiedTo === undefined ? remembered.id : undefined
}

/** The M1 row (kind 'turbollm-sdk' with no SDK engine named) when rule 1 adopts it this start. */
function adoptedLegacySource({ engines }: AndroidEngineInput, rows: AndroidEngineAction[]): string | undefined {
  const adopts = rows.some((a) => a.kind === 'upsert-sdk' && a.adoptLegacy)
  return adopts ? engines.find(isLegacySdkRow)?.id : undefined
}

function isRetiredBy(rows: AndroidEngineAction[], engineId: string): boolean {
  return rows.some((a) => a.kind === 'retire' && a.engineId === engineId)
}

function sdkEngineAvailable({ sdk }: AndroidEngineInput, sdkEngineId: string): boolean {
  return sdk?.engines?.some((info) => info.id === sdkEngineId && info.available) ?? false
}

function isLegacySdkRow(engine: Engine): boolean {
  return engine.kind === TURBOLLM_SDK_KIND && !engine.sdkEngine
}

/** The app's own row for a bundled engine: its bundled name on a binary of the bundled file's name, in this install's
 *  nativeLibraryDir or an earlier one (a reinstall moves it). A user's engine of the same kind is never it. */
function ownBundledRow(engines: Engine[], name: string, file: string): Engine | undefined {
  return engines.find((e) => e.name === name && basename(e.binPath) === file)
}
