// Adapter loading (spec 27 §4.5).
//
// Every failure here ABORTS STARTUP. Falling back to SQLite when an integrator's adapter
// is broken would write their users' data to the wrong database — the worst failure mode
// available — so a bad adapter must be loud and fatal, never quietly survivable.
import { pathToFileURL } from 'node:url'
import { isAbsolute, resolve } from 'node:path'
import type { ChatStore } from './chat-store.js'

export interface ChatStoreConfig {
  kind: 'sqlite' | 'module'
  /** Module path (relative to the data dir, or absolute) or bare npm package name. */
  specifier?: string
  options?: Record<string, unknown>
}

const REQUIRED_METHODS = [
  'createChat', 'getChat', 'listChats', 'updateChat', 'deleteChat',
  'addMessage', 'getMessage', 'listMessages', 'updateMessage', 'deleteMessage',
  'getLastMessage', 'health', 'close',
] as const

class AdapterLoadError extends Error {
  constructor(message: string) {
    super(`chat-store adapter: ${message}`)
    this.name = 'AdapterLoadError'
  }
}

export async function loadChatStoreAdapter(cfg: ChatStoreConfig, dataDir: string): Promise<ChatStore | null> {
  if (cfg.kind === 'sqlite') return null
  if (!cfg.specifier) throw new AdapterLoadError(`kind is 'module' but no specifier was configured`)

  // A bare package name goes to the resolver untouched; anything path-like is resolved
  // against the data dir and converted to a file URL so Windows paths import correctly.
  const looksLikePath = cfg.specifier.startsWith('.') || cfg.specifier.startsWith('/') || isAbsolute(cfg.specifier)
  const target = looksLikePath ? pathToFileURL(resolve(dataDir, cfg.specifier)).href : cfg.specifier

  let mod: { default?: unknown }
  try {
    mod = (await import(target)) as { default?: unknown }
  } catch (e) {
    throw new AdapterLoadError(`could not import '${cfg.specifier}': ${(e as Error).message}`)
  }

  if (typeof mod.default !== 'function') {
    throw new AdapterLoadError(`'${cfg.specifier}' has no default export that is a factory function`)
  }

  let store: ChatStore
  try {
    store = (await (mod.default as (o: Record<string, unknown>) => ChatStore | Promise<ChatStore>)(cfg.options ?? {}))
  } catch (e) {
    throw new AdapterLoadError(`factory in '${cfg.specifier}' threw: ${(e as Error).message}`)
  }

  if (!store || typeof store !== 'object') {
    throw new AdapterLoadError(`factory in '${cfg.specifier}' did not return an object`)
  }
  for (const m of REQUIRED_METHODS) {
    if (typeof (store as unknown as Record<string, unknown>)[m] !== 'function') {
      throw new AdapterLoadError(`'${cfg.specifier}' is missing required method '${m}'`)
    }
  }

  let health: { ok: boolean; detail?: string }
  try {
    health = await store.health()
  } catch (e) {
    throw new AdapterLoadError(`health check threw: ${(e as Error).message}`)
  }
  if (!health.ok) {
    throw new AdapterLoadError(`health check failed: ${health.detail ?? 'no detail given'}`)
  }

  return store
}
