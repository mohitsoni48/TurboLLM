// The Android app's engine rows (ADR-462, architecture §3.4): one row per engine the in-app TurboLLM SDK reports, the
// spawned engines the APK ships in nativeLibraryDir, and the one settings copy between them. planAndroidEngines is a
// pure planner over the rows, the remembered retired rows, the shipped files and the SDK's engine list.
import { existsSync } from 'node:fs'
import { basename, join } from 'node:path'
import {
  migrateEngineId, type AndroidSdkFallback, type ConfigStore, type Engine, type LastLoaded, type RetiredEngine,
} from '../config/config'
import { engineFormats, isSdkRow, type ModelFormat } from './compat'
import { LITERT_LM_NATIVE_SERVER, litertLmNativeVersion } from './litert-lm'
import type { Registry } from './registry'
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

export interface AndroidEngineInput {
  engines: Engine[]
  activeEngineId: string
  lastLoaded: LastLoaded
  /** cfg.androidRetiredEngines */
  retired: Record<string, RetiredEngine>
  /** Which ANDROID_BUNDLED_ENGINES files exist in nativeLibraryDir. */
  nativeLibFiles: ReadonlySet<string>
  /** null: the app did not start the SDK this launch. `engines` null: its list could not be read. */
  sdk: { baseUrl: string; engines: SdkEngineInfo[] | null } | null
  /** From the boot scan. */
  formatOf: (modelKey: string) => ModelFormat | undefined
  /** cfg.androidSdkFallback: an earlier start without the SDK moved the selection to the CPU server. */
  sdkFallback?: AndroidSdkFallback
}

/** `copy-state` names its target, and `activate` a row this start creates, by SDK engine id (or, for a spawned row
 *  registered this start, its bundled name): a new row's id exists only once the applier has added it. An `activate`
 *  with `fallbackFrom` is the CPU server standing in for the SDK this launch, remembered once it really happens. */
export type AndroidEngineAction =
  | { kind: 'upsert-sdk'; info: SdkEngineInfo; adoptLegacy: boolean }
  | { kind: 'reinstate-sdk'; info: SdkEngineInfo }
  | { kind: 'repair-sdk-url'; baseUrl: string }
  | { kind: 'register-bundled' | 'repair-bundled'; name: string; file: string }
  | { kind: 'reinstate-bundled'; name: string; file: string }
  | { kind: 'retire'; engineId: string; remember: boolean; key: string }
  | { kind: 'copy-state'; from: string; to: string; format: ModelFormat }
  | { kind: 'activate'; engineId: string; fallbackFrom?: string }
  | { kind: 'forget-fallback' }

/** What the reconciler does this start, in order: SDK rows (rule 1), spawned rows (rule 2), the one copy (rule 3), and
 *  at most one activation (rule 4). */
export function planAndroidEngines(input: AndroidEngineInput): AndroidEngineAction[] {
  const rows = [...planSdkRows(input), ...planBundledRows(input)]
  const activation = planActivation(input, rows)
  return [...rows, ...planCopies(input, rows), ...activation]
}

/** Rule 1: one upsert per available SDK engine, the first reading GGUF adopting the M1 row; an SDK row whose engine is
 *  no longer available is retired and remembered as `sdk:<id>`, and reinstated under that id when the engine returns
 *  (D-15, I-3). An unreadable list only repairs the URL: nothing is registered or retired on a guess. */
function planSdkRows({ sdk, engines, retired }: AndroidEngineInput): AndroidEngineAction[] {
  if (!sdk) return []
  if (!sdk.engines) return [{ kind: 'repair-sdk-url', baseUrl: sdk.baseUrl }]
  const available = sdk.engines.filter((info) => info.available)
  const adopter = available.find((info) => info.formats.includes('gguf'))
  const keeps = available.map((info): AndroidEngineAction => {
    if (!existingSdkRow(engines, info.id) && retired[retiredSdkKey(info.id)]) return { kind: 'reinstate-sdk', info }
    return { kind: 'upsert-sdk', info, adoptLegacy: info === adopter }
  })
  const availableIds = new Set(available.map((info) => info.id))
  const retires = engines
    .filter(isNamedSdkRow)
    .filter((e) => !availableIds.has(e.sdkEngine.id))
    .map((e): AndroidEngineAction => ({ kind: 'retire', engineId: e.id, remember: true, key: retiredSdkKey(e.sdkEngine.id) }))
  return [...keeps, ...retires]
}

/** An SDK row that names its SDK engine: every row but the M1 legacy one. */
type NamedSdkRow = Engine & Required<Pick<Engine, 'sdkEngine'>>

function isNamedSdkRow(engine: Engine): engine is NamedSdkRow {
  return isSdkRow(engine) && engine.sdkEngine !== undefined
}

/** The key a retired SDK row is remembered under in androidRetiredEngines, beside the bundled rows' names. */
function retiredSdkKey(sdkEngineId: string): string {
  return `sdk:${sdkEngineId}`
}

function existingSdkRow(engines: Engine[], sdkEngineId: string): Engine | undefined {
  return engines.find((e) => isSdkRow(e) && e.sdkEngine?.id === sdkEngineId)
}

/** Rule 2: a shipped file is repaired, reinstated under its remembered id, or registered; the app's own row for a file
 *  this APK does not ship is retired and remembered. No settings move between rows. */
function planBundledRows({ engines, retired, nativeLibFiles }: AndroidEngineInput): AndroidEngineAction[] {
  return ANDROID_BUNDLED_ENGINES.flatMap(({ name, file }): AndroidEngineAction[] => {
    const own = ownBundledRow(engines, name, file)
    if (!nativeLibFiles.has(file)) return own ? [{ kind: 'retire', engineId: own.id, remember: true, key: name }] : []
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
 *  (I-4), and when nothing usable is active, onto the row that reads lastLoaded (I-5). The CPU server standing in for
 *  the SDK is remembered, and undone on the next start whose SDK list is readable (MAJ-1). */
function planActivation(input: AndroidEngineInput, rows: AndroidEngineAction[]): AndroidEngineAction[] {
  const live = liveRowsAfter(input, rows)
  if (input.sdkFallback && input.sdk?.engines) return planFallbackEnd(input, input.sdkFallback, rows, live)
  return activationsOf(input, activationTarget(input, rows, live))
}

/** The SDK is back: the row active before the fallback, as rule 4 would treat it were it still active, unless the user
 *  picked an engine since, or the restore would strand the last model (FD-1). Either way the fallback is over. */
function planFallbackEnd(
  input: AndroidEngineInput,
  fallback: AndroidSdkFallback,
  rows: AndroidEngineAction[],
  live: PlannedRow[],
): AndroidEngineAction[] {
  const forget: AndroidEngineAction = { kind: 'forget-fallback' }
  if (input.activeEngineId !== fallback.to) return [forget]
  const restored = activationTarget({ ...input, activeEngineId: fallback.from }, rows, live)
    ?? activationOf(live.find((r) => r.ref === fallback.from))
  if (restored && strandsLastModel(input, live, restored.engineId)) return [forget]
  return [...activationsOf(input, restored), forget]
}

/** I-5 over the restore: the CPU server runs the last model (one the user loaded on it during the fallback) and the
 *  earlier row cannot. When the CPU server cannot run it either, the earlier pick returns (MAJ-1 case 8), and a
 *  lastLoaded of unknown format never blocks it. */
function strandsLastModel(input: AndroidEngineInput, live: PlannedRow[], target: string): boolean {
  const lastFormat = lastModelFormat(input)
  if (lastFormat === undefined) return false
  const reads = (ref: string) => live.some((r) => r.ref === ref && r.formats.includes(lastFormat))
  return reads(input.activeEngineId) && !reads(target)
}

function lastModelFormat({ lastLoaded, formatOf }: AndroidEngineInput): ModelFormat | undefined {
  return lastLoaded.modelKey ? formatOf(lastLoaded.modelKey) : undefined
}

type Activation = Omit<Extract<AndroidEngineAction, { kind: 'activate' }>, 'kind'>

function activationsOf(input: AndroidEngineInput, activation: Activation | undefined): AndroidEngineAction[] {
  return activation && activation.engineId !== input.activeEngineId ? [{ kind: 'activate', ...activation }] : []
}

function activationTarget(input: AndroidEngineInput, rows: AndroidEngineAction[], live: PlannedRow[]): Activation | undefined {
  const lastFormat = lastModelFormat(input)
  const active = activeRow(input)
  if (!active || isRetiredBy(rows, active.id)) {
    if (!isFreshInstall(input)) return activationOf(rowForLastLoaded(input, live, lastFormat))
    return activationOf(defaultRow(live), input.sdk === null ? FRESH_INSTALL_FALLBACK : undefined)
  }
  if (isLegacySdkRow(active) && lastFormat === 'litertlm' && sdkEngineAvailable(input, SDK_LITERT_ENGINE_ID)) {
    return activationOf(plannedSdkRowFor(live, SDK_LITERT_ENGINE_ID))
  }
  if (input.sdk === null && isSdkRow(active)) return activationOf(spawnedCpuRow(live), active.id)
  return undefined
}

/** The `fallbackFrom` of a fresh install's CPU server: no row was active. */
const FRESH_INSTALL_FALLBACK = ''

function activationOf(row: PlannedRow | undefined, fallbackFrom?: string): Activation | undefined {
  if (!row) return undefined
  return fallbackFrom === undefined ? { engineId: row.ref } : { engineId: row.ref, fallbackFrom }
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
  return plannedSdkRowFor(live, SDK_LITERT_ENGINE_ID)
    ?? live.find((r) => r.origin === 'sdk' && r.formats.includes('gguf'))
    ?? spawnedCpuRow(live)
}

function plannedSdkRowFor(live: PlannedRow[], sdkEngineId: string): PlannedRow | undefined {
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

function liveSdkRows({ sdk, engines, retired }: AndroidEngineInput, rows: AndroidEngineAction[]): PlannedRow[] {
  if (!sdk) return []
  const kept = engines.filter((e) => isSdkRow(e) && !isRetiredBy(rows, e.id))
  if (!sdk.engines) return kept.map(plannedSdkRow)
  const upserted = rows.filter(isSdkKeep).map((a): PlannedRow => ({
    ref: a.kind === 'reinstate-sdk' ? retired[retiredSdkKey(a.info.id)].id : (rowUpsertedBy(engines, a)?.id ?? a.info.id),
    origin: 'sdk',
    sdkEngineId: a.info.id,
    formats: a.info.formats,
  }))
  const legacyLeft = kept.filter((e) => isLegacySdkRow(e) && !upserted.some((r) => r.ref === e.id))
  return [...upserted, ...legacyLeft.map(plannedSdkRow)]
}

function liveBundledRows({ engines, retired }: AndroidEngineInput, rows: AndroidEngineAction[]): PlannedRow[] {
  return ANDROID_BUNDLED_ENGINES.flatMap(({ name, kind }): PlannedRow[] => {
    const action = rows.filter(isBundledKeep).find((a) => a.name === name)
    if (!action) return []
    return [{ ref: bundledRef(action, engines, retired), origin: 'bundled', bundledName: name, formats: engineFormats({ kind }) }]
  })
}

/** The id a kept spawned row will have: its own, the remembered one, or (a new registration) its bundled name. */
function bundledRef(action: BundledKeep, engines: Engine[], retired: AndroidEngineInput['retired']): string {
  if (action.kind === 'reinstate-bundled') return retired[action.name].id
  if (action.kind === 'repair-bundled') return ownBundledRow(engines, action.name, action.file)?.id ?? action.name
  return action.name
}

function otherRows({ engines }: AndroidEngineInput): PlannedRow[] {
  return engines.filter((e) => !isAppOwnedRow(e)).map((e) => ({ ref: e.id, origin: 'other', formats: engineFormats(e) }))
}

function plannedSdkRow(engine: Engine): PlannedRow {
  return { ref: engine.id, origin: 'sdk', sdkEngineId: engine.sdkEngine?.id, formats: engineFormats(engine) }
}

/** The existing row an upsert lands on, as Registry.upsertSdkEngine finds it. */
function rowUpsertedBy(engines: Engine[], { info, adoptLegacy }: UpsertSdk): Engine | undefined {
  return existingSdkRow(engines, info.id) ?? (adoptLegacy ? engines.find(isLegacySdkRow) : undefined)
}

type UpsertSdk = Extract<AndroidEngineAction, { kind: 'upsert-sdk' }>
type SdkKeep = Extract<AndroidEngineAction, { kind: 'upsert-sdk' | 'reinstate-sdk' }>

function isSdkKeep(action: AndroidEngineAction): action is SdkKeep {
  return action.kind === 'upsert-sdk' || action.kind === 'reinstate-sdk'
}
type BundledKeep = Extract<AndroidEngineAction, { kind: 'register-bundled' | 'repair-bundled' | 'reinstate-bundled' }>

function isBundledKeep(action: AndroidEngineAction): action is BundledKeep {
  return action.kind === 'register-bundled' || action.kind === 'repair-bundled' || action.kind === 'reinstate-bundled'
}

function activeRow({ engines, activeEngineId }: AndroidEngineInput): Engine | undefined {
  return activeEngineId ? engines.find((e) => e.id === activeEngineId) : undefined
}

function isAppOwnedRow(engine: Engine): boolean {
  return isSdkRow(engine) || ANDROID_BUNDLED_ENGINES.some(({ name, file }) => isOwnBundledRow(engine, name, file))
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
  return isSdkRow(engine) && !engine.sdkEngine
}

/** The app's own row for a bundled engine: its bundled name on a binary of the bundled file's name, in this install's
 *  nativeLibraryDir or an earlier one (a reinstall moves it). A user's engine of the same kind is never it. */
function ownBundledRow(engines: Engine[], name: string, file: string): Engine | undefined {
  return engines.find((e) => isOwnBundledRow(e, name, file))
}

function isOwnBundledRow(engine: Engine, name: string, file: string): boolean {
  return engine.name === name && basename(engine.binPath) === file
}

export interface AndroidEngineDeps {
  registry: Registry
  store: Pick<ConfigStore, 'snapshot' | 'update'>
  env: NodeJS.ProcessEnv
  readSdk: (baseUrl: string, env: NodeJS.ProcessEnv) => Promise<SdkEngineInfo[] | null>
  /** The boot scan's format lookup. Called only after the first await: cli.ts declares the scanner after this call. */
  formatOf: () => Promise<FormatLookup>
}

type FormatLookup = (modelKey: string) => ModelFormat | undefined

/** One Android start's engine rows: reads the SDK's engine list and the boot scan, plans, and applies the plan in
 *  order. A no-op outside the packaged app, where it returns before any await. Never throws: every step logs its own
 *  failure with the `android:` prefix and the start goes on. */
export async function reconcileAndroidEngines(deps: AndroidEngineDeps): Promise<void> {
  const nativeLibDir = deps.env.TURBOLLM_ANDROID_NATIVE_LIB_DIR
  if (!nativeLibDir) return
  try {
    const sdk = await sdkThisLaunch(deps)
    const formatOf = await scanLookup(deps)
    const input = androidEngineInput(deps.store, { nativeLibDir, sdk, formatOf })
    await new AndroidEngineApplier(deps, input, nativeLibDir).apply(planAndroidEngines(input))
  } catch (e) {
    console.warn(`android: could not reconcile the engines (${messageOf(e)})`)
  }
}

/** The SDK this launch: null when the app did not start it; its list null when that list could not be read. */
async function sdkThisLaunch({ env, readSdk }: AndroidEngineDeps): Promise<AndroidEngineInput['sdk']> {
  const baseUrl = env.TURBOLLM_ANDROID_SDK_URL
  if (!baseUrl) return null
  try {
    return { baseUrl, engines: await readSdk(baseUrl, env) }
  } catch (e) {
    console.warn(`android: could not read the in-app SDK's engines (${messageOf(e)}); its rows are kept as they are`)
    return { baseUrl, engines: null }
  }
}

async function scanLookup({ formatOf }: AndroidEngineDeps): Promise<FormatLookup> {
  try {
    return await formatOf()
  } catch (e) {
    console.warn(`android: the model scan could not be read (${messageOf(e)}); no model's format is known`)
    return () => undefined
  }
}

function androidEngineInput(
  store: AndroidEngineDeps['store'],
  launch: { nativeLibDir: string; sdk: AndroidEngineInput['sdk']; formatOf: FormatLookup },
): AndroidEngineInput {
  const cfg = store.snapshot()
  return {
    engines: cfg.engines,
    activeEngineId: cfg.activeEngineId,
    lastLoaded: cfg.lastLoaded,
    retired: cfg.androidRetiredEngines ?? {},
    nativeLibFiles: shippedFiles(launch.nativeLibDir),
    sdk: launch.sdk,
    formatOf: launch.formatOf,
    sdkFallback: cfg.androidSdkFallback,
  }
}

function shippedFiles(nativeLibDir: string): ReadonlySet<string> {
  return new Set(ANDROID_BUNDLED_ENGINES.map((b) => b.file).filter((file) => existsSync(join(nativeLibDir, file))))
}

/** Carries out one start's plan against the registry and the config, one action at a time, each in its own try. */
class AndroidEngineApplier {
  /** A plan's reference to a row it creates (an SDK engine id, a bundled name) → that row's id. */
  private readonly rowIds = new Map<string, string>()
  /** The selection as this start left it. Any other selection at activation time is the user's, made meanwhile. */
  private expectedActive: string

  constructor(
    private readonly deps: AndroidEngineDeps,
    private readonly input: AndroidEngineInput,
    private readonly nativeLibDir: string,
  ) {
    this.expectedActive = input.activeEngineId
  }

  async apply(actions: AndroidEngineAction[]): Promise<void> {
    for (const action of actions) {
      try {
        await this.carryOut(action)
      } catch (e) {
        console.warn(`android: could not ${action.kind} (${messageOf(e)})`)
      }
    }
    this.warnWhenNothingCanRun()
  }

  private carryOut(action: AndroidEngineAction): Promise<void> | void {
    switch (action.kind) {
      case 'upsert-sdk':
        return this.upsertSdk(action)
      case 'reinstate-sdk':
        return this.reinstateSdk(action.info)
      case 'repair-sdk-url':
        return this.repairSdkUrl(action.baseUrl)
      case 'register-bundled':
        return this.registerBundled(action.name, action.file)
      case 'repair-bundled':
        return this.repairBundled(action.name, action.file)
      case 'reinstate-bundled':
        return this.reinstateBundled(action.name, action.file)
      case 'retire':
        return this.retire(action)
      case 'copy-state':
        return this.copyState(action)
      case 'activate':
        return this.activate(action)
      case 'forget-fallback':
        return this.forgetFallback()
    }
  }

  private upsertSdk({ info, adoptLegacy }: UpsertSdk): void {
    const baseUrl = this.sdkBaseUrl()
    const row = this.deps.registry.upsertSdkEngine(info, baseUrl, { adoptLegacy })
    this.rowIds.set(info.id, row.id)
    console.log(`android: in-app engine ${info.name} (${info.id}) at ${baseUrl}`)
  }

  /** An SDK engine back after a start without it returns as the same row, so its settings apply again (D-15, I-3). It
   *  is not selected: activation stays with rule 4. */
  private reinstateSdk(info: SdkEngineInfo): void {
    const key = retiredSdkKey(info.id)
    this.deps.registry.reinstate(asEngine(this.retiredEntry(key)), false)
    const row = this.deps.registry.upsertSdkEngine(info, this.sdkBaseUrl())
    this.rowIds.set(info.id, row.id)
    this.forgetRetired(key)
    console.log(`android: in-app engine ${info.name} (${info.id}) is back under its earlier id`)
  }

  private repairSdkUrl(baseUrl: string): void {
    this.deps.store.update((c) => {
      for (const e of c.engines) if (isSdkRow(e)) e.baseUrl = baseUrl
    })
    console.log(`android: the in-app SDK's engine list could not be read; its rows keep their engines, at ${baseUrl}`)
  }

  private async registerBundled(name: string, file: string): Promise<void> {
    const binPath = join(this.nativeLibDir, file)
    const added = isLitertServer(name)
      ? this.deps.registry.addLitertLm(name, binPath, await bundledLitertVersion(name, binPath), NO_SELECTION)
      : (await this.deps.registry.add(name, binPath, undefined, NO_SELECTION)).engine
    this.rowIds.set(name, added.id)
    console.log(`android: registered bundled engine ${name} at ${binPath}`)
  }

  private async repairBundled(name: string, file: string): Promise<void> {
    const own = ownBundledRow(this.deps.registry.list().engines, name, file)
    if (!own) throw new Error(`${name} is no longer registered`)
    const binPath = join(this.nativeLibDir, file)
    const version = isLitertServer(name) ? await bundledLitertVersion(name, binPath, own.version) : own.version
    if (own.binPath === binPath && own.version === version) return
    await this.deps.registry.repairBinPath(own.id, binPath, isLitertServer(name) ? version : undefined)
    console.log(`android: repaired bundled engine ${name} → ${binPath}`)
  }

  /** The row a rollback build ships again comes back under its remembered id, with the settings still keyed on it. */
  private async reinstateBundled(name: string, file: string): Promise<void> {
    const remembered = asEngine(this.retiredEntry(name))
    this.deps.registry.reinstate(remembered, false)
    this.rowIds.set(name, remembered.id)
    console.log(`android: reinstated bundled engine ${name} under its earlier id`)
    try {
      await this.repairBundled(name, file)
    } catch (e) {
      console.warn(`android: could not repair ${name} (${messageOf(e)})`)
    }
    this.forgetRetired(name)
  }

  private retire({ engineId, remember, key }: Extract<AndroidEngineAction, { kind: 'retire' }>): void {
    const row = this.deps.registry.get(engineId)
    if (!row) throw new Error(`engine ${engineId} is no longer registered`)
    if (remember) this.rememberRetired(key, row)
    this.deps.registry.remove(engineId)
    if (this.expectedActive === engineId) this.expectedActive = ''
    console.log(`android: retired engine ${row.name}: it cannot run in this app build or launch`)
  }

  /** Copies `from`'s settings for models of `format` onto `to`'s row, once (the source keeps its own). */
  private copyState({ from, to, format }: CopyState): void {
    const toId = this.rowIdOf(to)
    const isOfFormat = (modelKey: string) => this.input.formatOf(modelKey) === format
    this.deps.store.update((c) => {
      migrateEngineId(c, from, toId, { copy: true, onlyModel: isOfFormat })
      const litertServer = c.androidRetiredEngines?.[ANDROID_LITERT_LM_ENGINE_NAME]
      if (litertServer?.id === from) litertServer.copiedTo = toId
    })
    console.log(`android: copied the ${format} model settings of engine ${from} onto ${toId}`)
  }

  private activate({ engineId: ref, fallbackFrom }: Extract<AndroidEngineAction, { kind: 'activate' }>): void {
    const engineId = this.rowIdOf(ref)
    if (this.deps.registry.list().activeEngineId !== this.expectedActive) {
      console.log(`android: skipped activating ${ref}: an engine was picked meanwhile`)
      return
    }
    this.deps.registry.activate(engineId)
    if (fallbackFrom !== undefined) this.rememberFallback({ from: fallbackFrom, to: engineId })
    console.log(`android: ${this.deps.registry.get(engineId)?.name ?? engineId} is the active engine`)
  }

  private rememberFallback(fallback: AndroidSdkFallback): void {
    this.deps.store.update((c) => {
      c.androidSdkFallback = fallback
    })
  }

  private forgetFallback(): void {
    this.deps.store.update((c) => {
      delete c.androidSdkFallback
    })
  }

  private warnWhenNothingCanRun(): void {
    if (this.input.sdk === null) this.warnWhenNoEngineShips()
    else this.warnWhenNoEngineIsActive()
  }

  private warnWhenNoEngineIsActive(): void {
    if (this.deps.registry.list().activeEngineId !== '') return
    console.warn('android: no engine is active this launch: no available engine reads the last model\'s format; pick one in Engines')
  }

  private warnWhenNoEngineShips(): void {
    if (this.input.nativeLibFiles.has(SPAWNED_CPU_FILE)) return
    console.warn(`android: no engine can run this launch: the in-app SDK did not start and ${SPAWNED_CPU_FILE} is not in this build`)
  }

  private rowIdOf(ref: string): string {
    return this.rowIds.get(ref) ?? ref
  }

  private sdkBaseUrl(): string {
    if (!this.input.sdk) throw new Error('the in-app SDK did not start this launch')
    return this.input.sdk.baseUrl
  }

  private retiredEntry(key: string): RetiredEngine {
    const entry = this.deps.store.snapshot().androidRetiredEngines?.[key]
    if (!entry) throw new Error(`no remembered ${key}`)
    return entry
  }

  private rememberRetired(key: string, row: Engine): void {
    this.deps.store.update((c) => {
      const retired = c.androidRetiredEngines ?? {}
      const copiedTo = retired[key]?.copiedTo
      retired[key] = copiedTo === undefined ? { ...row } : { ...row, copiedTo }
      c.androidRetiredEngines = retired
    })
  }

  private forgetRetired(key: string): void {
    this.deps.store.update((c) => {
      if (c.androidRetiredEngines) delete c.androidRetiredEngines[key]
    })
  }
}

type CopyState = Extract<AndroidEngineAction, { kind: 'copy-state' }>

const NO_SELECTION = { fillEmptySelection: false }
const SPAWNED_CPU_FILE = bundledFileOf(ANDROID_ENGINE_NAME)

/** Looked up by name: the list's order is the planner's preference, not which engine is which. */
function bundledFileOf(name: string): string {
  const bundled = ANDROID_BUNDLED_ENGINES.find((b) => b.name === name)
  if (!bundled) throw new Error(`${name} is not a bundled engine`)
  return bundled.file
}

function isLitertServer(name: string): boolean {
  return ANDROID_BUNDLED_ENGINES.some((b) => b.name === name && b.kind === 'litert-lm')
}

/** A remembered row as the engine row it was, without the reconciler's own bookkeeping. */
function asEngine({ copiedTo, ...engine }: RetiredEngine): Engine {
  void copiedTo
  return engine
}

/** The bundled LiteRT-LM server's runtime version, from its own --version, refreshed every start (an app update can ship
 *  a newer runtime at the same path). A failed probe keeps the version on record, or a placeholder, and never costs the
 *  engine: it ships in the APK. */
function bundledLitertVersion(name: string, binPath: string, onRecord?: string): Promise<string> {
  return litertLmNativeVersion(binPath).catch((err) => {
    console.warn(`android: ${name} --version failed (${messageOf(err)}); registering anyway`)
    return onRecord || UNKNOWN_BUNDLED_LITERT_VERSION
  })
}

const UNKNOWN_BUNDLED_LITERT_VERSION = 'litert-lm (bundled)'

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
