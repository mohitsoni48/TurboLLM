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

/** `copy-state` names its target, and `activate` a row this start creates, by SDK engine id (or, for a spawned row
 *  registered this start, its bundled name): a new row's id exists only once the applier has added it. */
export type AndroidEngineAction =
  | { kind: 'upsert-sdk'; info: SdkEngineInfo; adoptLegacy: boolean }
  | { kind: 'repair-sdk-url'; baseUrl: string }
  | { kind: 'register-bundled' | 'repair-bundled'; name: string; file: string }
  | { kind: 'reinstate-bundled'; name: string; file: string }
  | { kind: 'retire'; engineId: string; remember: boolean }
  | { kind: 'copy-state'; from: string; to: string; format: ModelFormat }
  | { kind: 'activate'; engineId: string }

/** What the reconciler does this start, in order: SDK rows (rule 1), spawned rows (rule 2), the one copy (rule 3), and
 *  at most one activation (rule 4). */
export function planAndroidEngines(input: AndroidEngineInput): AndroidEngineAction[] {
  const rows = [...planSdkRows(input), ...planBundledRows(input)]
  const activation = planActivation(input, rows)
  return [...rows, ...planCopies(input, rows), ...activation]
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

/** Rule 4: an engine is activated only on a fresh install, when nothing usable is active, for the M1 row with a
 *  `.litertlm` last model, or when the SDK did not start while an SDK row is active. Never over a live, runnable pick
 *  (I-4), and when nothing usable is active, onto the row that reads lastLoaded (I-5). */
function planActivation(input: AndroidEngineInput, rows: AndroidEngineAction[]): AndroidEngineAction[] {
  const target = activationTarget(input, rows, liveRowsAfter(input, rows))
  return target !== undefined && target !== input.activeEngineId ? [{ kind: 'activate', engineId: target }] : []
}

function activationTarget(input: AndroidEngineInput, rows: AndroidEngineAction[], live: PlannedRow[]): string | undefined {
  const lastFormat = input.lastLoaded.modelKey ? input.formatOf(input.lastLoaded.modelKey) : undefined
  const active = activeRow(input)
  if (!active || isRetiredBy(rows, active.id)) {
    return isFreshInstall(input) ? defaultRow(live)?.ref : rowForLastLoaded(input, live, lastFormat)?.ref
  }
  if (isLegacySdkRow(active) && lastFormat === 'litertlm') return sdkRowOf(live, SDK_LITERT_ENGINE_ID)?.ref
  if (input.sdk === null && active.kind === TURBOLLM_SDK_KIND) return spawnedCpuRow(live)?.ref
  return undefined
}

/** No app-owned row (spawned or SDK), nothing remembered as retired, and no model ever loaded. */
function isFreshInstall({ engines, retired, lastLoaded }: AndroidEngineInput): boolean {
  return !engines.some(isAppOwnedRow) && Object.keys(retired).length === 0 && lastLoaded.modelKey === ''
}

/** lastLoaded's own row when it is live and reads the last model's format; else the first app row that reads it (SDK
 *  rows in catalog order, then spawned rows); with no known format, the fresh-install default. A known format no row
 *  reads activates nothing rather than strand lastLoaded on an engine that cannot load it. */
function rowForLastLoaded(
  input: AndroidEngineInput,
  live: PlannedRow[],
  lastFormat: ModelFormat | undefined,
): PlannedRow | undefined {
  const own = live.find((r) => r.ref === input.lastLoaded.engineId)
  if (own && (lastFormat === undefined || own.formats.includes(lastFormat))) return own
  if (lastFormat === undefined) return defaultRow(live)
  return live.find((r) => r.origin !== 'other' && r.formats.includes(lastFormat))
}

/** The fresh-install default (founder Q2): the SDK's LiteRT-LM row, else the first SDK row reading GGUF, else the
 *  spawned CPU row. */
function defaultRow(live: PlannedRow[]): PlannedRow | undefined {
  return sdkRowOf(live, SDK_LITERT_ENGINE_ID)
    ?? live.find((r) => r.origin === 'sdk' && r.formats.includes('gguf'))
    ?? spawnedCpuRow(live)
}

function sdkRowOf(live: PlannedRow[], sdkEngineId: string): PlannedRow | undefined {
  return live.find((r) => r.origin === 'sdk' && r.sdkEngineId === sdkEngineId)
}

function spawnedCpuRow(live: PlannedRow[]): PlannedRow | undefined {
  return live.find((r) => r.origin === 'bundled' && r.bundledName === ANDROID_ENGINE_NAME)
}

/** A row as it will be once the plan is applied. `ref` is its id, or, for a row the plan creates, the SDK engine id
 *  (upsert-sdk) or the bundled name (register-bundled), which the applier resolves to the new row's id. */
interface PlannedRow {
  ref: string
  origin: 'sdk' | 'bundled' | 'other'
  sdkEngineId?: string
  bundledName?: string
  formats: ModelFormat[]
}

/** The rows that can run after the plan: SDK rows (none when the SDK did not start), spawned rows whose file ships,
 *  then every other row, in that order. */
function liveRowsAfter(input: AndroidEngineInput, rows: AndroidEngineAction[]): PlannedRow[] {
  return [...liveSdkRows(input, rows), ...liveBundledRows(input, rows), ...otherRows(input)]
}

function liveSdkRows({ sdk, engines }: AndroidEngineInput, rows: AndroidEngineAction[]): PlannedRow[] {
  if (!sdk) return []
  const kept = engines.filter((e) => e.kind === TURBOLLM_SDK_KIND && !isRetiredBy(rows, e.id))
  if (!sdk.engines) return kept.map(plannedSdkRow)
  const upserted = rows.filter(isUpsert).map((a): PlannedRow => ({
    ref: rowUpsertedBy(engines, a)?.id ?? a.info.id, origin: 'sdk', sdkEngineId: a.info.id, formats: a.info.formats,
  }))
  const legacyLeft = kept.filter((e) => isLegacySdkRow(e) && !upserted.some((r) => r.ref === e.id))
  return [...upserted, ...legacyLeft.map(plannedSdkRow)]
}

function liveBundledRows({ engines, retired }: AndroidEngineInput, rows: AndroidEngineAction[]): PlannedRow[] {
  return ANDROID_BUNDLED_ENGINES.flatMap(({ name, kind }): PlannedRow[] => {
    const action = rows.filter(isBundledKeep).find((a) => a.name === name)
    if (!action) return []
    return [{ ref: bundledRef(action, engines, retired), origin: 'bundled', bundledName: name, formats: kindFormats(kind) }]
  })
}

/** The id a kept spawned row will have: its own, the remembered one, or (a new registration) its bundled name. */
function bundledRef(action: BundledKeep, engines: Engine[], retired: AndroidEngineInput['retired']): string {
  if (action.kind === 'reinstate-bundled') return retired[action.name].id
  if (action.kind === 'repair-bundled') return ownBundledRow(engines, action.name, action.file)?.id ?? action.name
  return action.name
}

function otherRows({ engines }: AndroidEngineInput): PlannedRow[] {
  return engines.filter((e) => !isAppOwnedRow(e)).map((e) => ({ ref: e.id, origin: 'other', formats: rowFormats(e) }))
}

function plannedSdkRow(engine: Engine): PlannedRow {
  return { ref: engine.id, origin: 'sdk', sdkEngineId: engine.sdkEngine?.id, formats: rowFormats(engine) }
}

/** The existing row an upsert lands on, as Registry.upsertSdkEngine finds it. */
function rowUpsertedBy(engines: Engine[], { info, adoptLegacy }: UpsertSdk): Engine | undefined {
  const sdkRows = engines.filter((e) => e.kind === TURBOLLM_SDK_KIND)
  return sdkRows.find((e) => e.sdkEngine?.id === info.id) ?? (adoptLegacy ? sdkRows.find(isLegacySdkRow) : undefined)
}

type UpsertSdk = Extract<AndroidEngineAction, { kind: 'upsert-sdk' }>
type BundledKeep = Extract<AndroidEngineAction, { kind: 'register-bundled' | 'repair-bundled' | 'reinstate-bundled' }>

function isUpsert(action: AndroidEngineAction): action is UpsertSdk {
  return action.kind === 'upsert-sdk'
}

function isBundledKeep(action: AndroidEngineAction): action is BundledKeep {
  return action.kind === 'register-bundled' || action.kind === 'repair-bundled' || action.kind === 'reinstate-bundled'
}

/** The formats a row reads. TODO(D-8): replaced by compat's engineFormats, which this table mirrors for the kinds an
 *  Android start can hold. */
function rowFormats(engine: Engine): ModelFormat[] {
  if (engine.sdkEngine) return engine.sdkEngine.formats
  return kindFormats(engine.kind)
}

function kindFormats(kind: string): ModelFormat[] {
  if (kind === TURBOLLM_SDK_KIND) return ['gguf', 'litertlm']
  if (kind === 'litert-lm') return ['litertlm']
  if (kind === 'llama-server') return ['gguf']
  return []
}

function activeRow({ engines, activeEngineId }: AndroidEngineInput): Engine | undefined {
  return activeEngineId ? engines.find((e) => e.id === activeEngineId) : undefined
}

function isAppOwnedRow(engine: Engine): boolean {
  return engine.kind === TURBOLLM_SDK_KIND
    || ANDROID_BUNDLED_ENGINES.some(({ name, file }) => engine.name === name && basename(engine.binPath) === file)
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
