// The Android engine reconciler's test harness (ADR-462), shared by its planner, applier and migration tests and by the
// SDK registry and reader tests: the SDK's two engines, the app's bundled rows, a Registry whose llama-server
// registration skips the binary probe, and one Android start over a real temp config.json.
import { randomUUID } from 'node:crypto'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ConfigStore, Engine } from '../config/config'
import {
  ANDROID_BUNDLED_ENGINES, ANDROID_ENGINE_NAME, ANDROID_VULKAN_ENGINE_NAME, reconcileAndroidEngines,
} from '../engines/android-engines'
import { isSdkRow, type ModelFormat } from '../engines/compat'
import { Registry } from '../engines/registry'
import type { SdkEngineInfo } from '../engines/sdk-engines'

export const LLAMA_INFO: SdkEngineInfo = {
  id: 'llama.cpp-cpu', name: 'llama.cpp (CPU)', kind: 'llama.cpp', formats: ['gguf'], backends: ['cpu'], available: true,
}
export const LITERT_INFO: SdkEngineInfo = {
  id: 'litert-lm', name: 'LiteRT-LM', kind: 'litert-lm', formats: ['litertlm'], backends: ['gpu', 'cpu'], available: true,
}

export const CPU_FILE = bundledFileOf(ANDROID_ENGINE_NAME)
export const VK_FILE = bundledFileOf(ANDROID_VULKAN_ENGINE_NAME)

function bundledFileOf(name: string): string {
  const bundled = ANDROID_BUNDLED_ENGINES.find((b) => b.name === name)
  if (!bundled) throw new Error(`${name} is not a bundled engine`)
  return bundled.file
}

export function engineRow(id: string, name: string, kind: string, extra: Partial<Engine> = {}): Engine {
  return { id, name, binPath: '', kind, version: '1', capabilities: { kvTypes: [], flags: [] }, addedAt: '', ...extra }
}

/** The app's own row for a bundled engine: its bundled name on `file` in nativeLibraryDir `dir`. */
export function bundledRow(id: string, name: string, dir: string, file: string, kind = 'llama-server'): Engine {
  return engineRow(id, name, kind, { binPath: join(dir, file) })
}

/** An APK's nativeLibraryDir holding exactly `files`. */
export function shipNativeLibs(dir: string, files: string[]): void {
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  for (const file of files) writeFileSync(join(dir, file), '')
}

export type MockedConsole = { mock: { callCount(): number; calls: { arguments: unknown[] }[] } }
export type AndroidTest = { mock: { method: (o: object, m: string, f: (...args: never[]) => unknown) => unknown } }

/** Silences the reconciler's `android:` lines and returns them for assertions. */
export function quietAndroidLog(t: AndroidTest): { logs: MockedConsole; warns: MockedConsole } {
  const logs = t.mock.method(console, 'log', () => {}) as MockedConsole
  const warns = t.mock.method(console, 'warn', () => {}) as MockedConsole
  return { logs, warns }
}

type AddOpts = { fillEmptySelection?: boolean }

export interface AndroidApp {
  store: ConfigStore
  registry: Registry
  /** The options each llama-server registration was made with. */
  addOpts: AddOpts[]
}

/** A Registry over `store` whose llama-server registration skips the binary probe, which a test cannot run on every
 *  platform, and keeps Registry.add's selection rule (fillEmptySelection). `onAdd` runs inside it, between the plan and
 *  the activation, as a user's tap in that window would. */
export function appRegistry(t: AndroidTest, store: ConfigStore, onAdd: (registry: Registry) => void = () => {}): AndroidApp {
  const registry = new Registry(store)
  const addOpts: AddOpts[] = []
  t.mock.method(registry, 'add', (async (name: string, binPath: string, _source: unknown, opts: AddOpts = {}) => {
    addOpts.push(opts)
    onAdd(registry)
    const engine = engineRow(randomUUID(), name, 'llama-server', { binPath })
    store.update((c) => {
      c.engines.push(engine)
      if (!c.activeEngineId && opts.fillEmptySelection !== false) c.activeEngineId = engine.id
    })
    return { engine }
  }) as never)
  return { store, registry, addOpts }
}

/** One Android start, as cli.ts runs it. */
export interface AndroidLaunch {
  nativeLibDir: string
  /** Unset: the app did not start the SDK this launch. */
  sdkUrl?: string
  /** The SDK's engine list (both engines when unset), null when it cannot be read, 'throws' for a failed read. */
  sdkEngines?: SdkEngineInfo[] | null | 'throws'
  /** The boot scan: each model key's format. */
  library: Readonly<Record<string, ModelFormat>>
}

export async function reconcileWith(app: Pick<AndroidApp, 'store' | 'registry'>, launch: AndroidLaunch): Promise<void> {
  const env: NodeJS.ProcessEnv = { TURBOLLM_ANDROID_NATIVE_LIB_DIR: launch.nativeLibDir }
  if (launch.sdkUrl) env.TURBOLLM_ANDROID_SDK_URL = launch.sdkUrl
  await reconcileAndroidEngines({
    registry: app.registry,
    store: app.store,
    env,
    readSdk: async () => {
      if (launch.sdkEngines === 'throws') throw new Error('sdk exploded')
      return launch.sdkEngines === undefined ? [LLAMA_INFO, LITERT_INFO] : launch.sdkEngines
    },
    formatOf: async () => (modelKey) => launch.library[modelKey],
  })
}

export function sdkRowsOf(registry: Registry): Engine[] {
  return registry.list().engines.filter(isSdkRow)
}

export function sdkRowFor(registry: Registry, sdkEngineId: string): Engine | undefined {
  return sdkRowsOf(registry).find((e) => e.sdkEngine?.id === sdkEngineId)
}
