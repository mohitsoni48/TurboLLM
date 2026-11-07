// The per-conversation language-server pool behind a Code session's LSP diagnostics. Module-level, keyed by convId (a
// session function runs once PER TURN, so a per-turn client would pay the npx cold start every turn — see ADR-204).
// A language server is 150–500 MB, so an entry must not live "until the session is deleted": routine runs create a
// session per fire and nothing deletes them for a long while. Entries end four ways: explicit disposal (session
// delete / archive / routine run end), an idle TTL, an LRU cap on the pool as a whole, and the client's own restart
// after its process dies (lsp-client.ts). None of them ever disposes a client during a call: use() holds it.
import type { LspServerSpec } from './lsp-registry'
import { LspClient } from './lsp-client'
import { daemonTick } from '../util/daemon-ticks'

export interface PooledLspClient { dispose(): void }

interface Entry<T> { client: T; inUse: number; lastUsed: number; disposeWhenIdle: boolean }

export interface LspPoolOptions<T extends PooledLspClient> {
  create: (spec: LspServerSpec, rootDir: string) => T
  now?: () => number
  /** A client unused this long is disposed by the next sweep. */
  ttlMs: number
  /** Most clients kept at once; creating one beyond it evicts the least recently used idle client. */
  maxClients: number
  /** How often the daemon-side timer sweeps; 0 = no timer (tests call sweep() themselves). */
  sweepIntervalMs: number
}

export class LspPool<T extends PooledLspClient> {
  private readonly byConv = new Map<string, Map<string, Entry<T>>>()
  private timer: NodeJS.Timeout | null = null
  private readonly now: () => number

  constructor(private readonly opts: LspPoolOptions<T>) { this.now = opts.now ?? Date.now }

  get size(): number {
    let n = 0
    for (const m of this.byConv.values()) n += m.size
    return n
  }

  /** Runs `fn` with the (lazily created) client for `convId` + `spec.language`, holding it against disposal until `fn`
   *  settles. The idle clock restarts when it does. */
  async use<R>(convId: string, spec: LspServerSpec, rootDir: string, fn: (client: T) => Promise<R>): Promise<R> {
    const entry = this.entryFor(convId, spec, rootDir)
    entry.inUse++
    try {
      return await fn(entry.client)
    } finally {
      entry.inUse--
      entry.lastUsed = this.now()
      if (entry.inUse === 0 && entry.disposeWhenIdle) this.drop(convId, spec.language, entry)
    }
  }

  /** Disposes every client of `convId` (all languages); one mid-call is disposed the moment its call ends. */
  disposeConv(convId: string): void {
    const clients = this.byConv.get(convId)
    if (!clients) return
    for (const [language, entry] of [...clients]) {
      if (entry.inUse > 0) entry.disposeWhenIdle = true
      else this.drop(convId, language, entry)
    }
  }

  /** Disposes every idle client unused for longer than the TTL. */
  sweep(): void {
    const cutoff = this.now() - this.opts.ttlMs
    for (const [convId, clients] of [...this.byConv]) {
      for (const [language, entry] of [...clients]) {
        if (entry.inUse === 0 && entry.lastUsed < cutoff) this.drop(convId, language, entry)
      }
    }
  }

  private entryFor(convId: string, spec: LspServerSpec, rootDir: string): Entry<T> {
    let clients = this.byConv.get(convId)
    if (!clients) { clients = new Map(); this.byConv.set(convId, clients) }
    let entry = clients.get(spec.language)
    if (entry && entry.disposeWhenIdle) entry = undefined // already condemned: a new call gets a fresh client
    if (!entry) {
      this.evictBeyondCap()
      entry = { client: this.opts.create(spec, rootDir), inUse: 0, lastUsed: this.now(), disposeWhenIdle: false }
      clients.set(spec.language, entry)
      this.armTimer()
    }
    return entry
  }

  /** Makes room for one more: disposes least-recently-used idle clients until the pool is below the cap. Clients in
   *  use are skipped, so the pool can exceed the cap rather than kill a live call. */
  private evictBeyondCap(): void {
    while (this.size >= this.opts.maxClients) {
      let oldest: { convId: string; language: string; entry: Entry<T> } | null = null
      for (const [convId, clients] of this.byConv) {
        for (const [language, entry] of clients) {
          if (entry.inUse === 0 && (!oldest || entry.lastUsed < oldest.entry.lastUsed)) oldest = { convId, language, entry }
        }
      }
      if (!oldest) return
      this.drop(oldest.convId, oldest.language, oldest.entry)
    }
  }

  private drop(convId: string, language: string, entry: Entry<T>): void {
    const clients = this.byConv.get(convId)
    if (clients?.get(language) === entry) {
      clients.delete(language)
      if (clients.size === 0) this.byConv.delete(convId)
    }
    entry.client.dispose()
    if (this.size === 0 && this.timer) { clearInterval(this.timer); this.timer = null }
  }

  // A daemonTick (unref'd, and stopped by the restart keeper with the rest); also stopped once the pool is empty.
  private armTimer(): void {
    if (this.timer || this.opts.sweepIntervalMs <= 0) return
    this.timer = daemonTick(() => this.sweep(), this.opts.sweepIntervalMs)
  }
}

const LSP_IDLE_TTL_MS = 15 * 60_000
const LSP_MAX_CLIENTS = 8
const LSP_SWEEP_INTERVAL_MS = 60_000

export const lspPool = new LspPool<LspClient>({
  create: (spec, rootDir) => new LspClient(spec, rootDir),
  ttlMs: LSP_IDLE_TTL_MS, maxClients: LSP_MAX_CLIENTS, sweepIntervalMs: LSP_SWEEP_INTERVAL_MS,
})
