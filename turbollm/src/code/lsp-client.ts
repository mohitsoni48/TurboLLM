// A minimal real LSP client: spawns a language server via npx, speaks actual JSON-RPC 2.0 over
// its stdio (Content-Length framed messages — the standard LSP transport), and returns real
// diagnostics after opening/updating a file. Built on `vscode-jsonrpc` (the same library VS Code's
// own client extensions use for this transport) rather than hand-rolling message framing — a
// well-tested dependency for the genuinely risky part, same precedent as this repo's own `diff`
// (jsdiff) dependency for reverse-patch application.
//
// One LspClient instance = one running language-server process for one `language` (see
// lsp-registry.ts — TS/JS share one `typescript-language-server` process). Diagnostics arrive as
// an async server-pushed notification (`textDocument/publishDiagnostics`), not a request/response,
// so `getDiagnostics` opens/updates the document then waits (with a timeout) for that push rather
// than requesting diagnostics directly — this is how every real LSP client works, there is no
// synchronous "give me diagnostics now" request in the protocol.
import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithStdioTuple } from 'node:child_process'
import { createMessageConnection, StreamMessageReader, StreamMessageWriter, type MessageConnection } from 'vscode-jsonrpc/node'
import { URI } from 'vscode-uri'
import type { LspServerSpec } from './lsp-registry'

// Node's built-in `pathToFileURL` produces `file:///C:/...` on Windows (uppercase drive letter,
// literal colon) — real LSP servers (built on the same `vscode-uri` conventions VS Code itself
// uses) publish diagnostics against `file:///c%3A/...` (lowercase drive, percent-encoded colon)
// instead. Confirmed live: with pathToFileURL, `getDiagnostics` sent one URI and the server's
// `publishDiagnostics` notification came back under a DIFFERENT (correctly-cased/encoded) URI key,
// so the diagnostics were silently stored under a key nothing ever looked up — an empty result
// with no error, the worst kind of silent failure. `vscode-uri` is the exact library that
// ecosystem uses to build those URIs, so using it here guarantees the two sides agree.
const toFileUri = (path: string): string => URI.file(path).toString()

export interface LspDiagnostic {
  severity: 'error' | 'warning' | 'info' | 'hint'
  line: number // 1-based, for human/model-readable output
  character: number
  message: string
  source?: string
}

const SEVERITY_NAMES: Record<number, LspDiagnostic['severity']> = { 1: 'error', 2: 'warning', 3: 'info', 4: 'hint' }

// Cold start needs to tolerate npx downloading the server package on first use (no global
// install — see lsp-registry.ts's own comment on why). Diagnostics-wait is much shorter: once the
// server is warm, real servers push diagnostics for an opened/changed file within a second or two.
const INITIALIZE_TIMEOUT_MS = 60_000
const DIAGNOSTICS_WAIT_MS = 5_000
const TSSERVER_RESOLVE_TIMEOUT_MS = 30_000

function npxSpawnOptions(cwd?: string): SpawnOptionsWithStdioTuple<'pipe', 'pipe', 'pipe'> {
  // Windows' `npx.cmd` is a batch file, not a real executable — node's spawn() throws `EINVAL`
  // trying to exec it directly (a documented Windows-only child_process gotcha; not an issue on
  // POSIX where `npx` is a real shell script). `shell: true` routes it through cmd.exe instead.
  // Safe here: every arg passed to npx throughout this file comes from lsp-registry.ts's own
  // hardcoded specs or a require.resolve() result, never from the model or user — no
  // shell-injection surface.
  return { cwd, stdio: ['pipe', 'pipe', 'pipe'], shell: process.platform === 'win32' }
}

// typescript-language-server resolves its `typescript` dependency from the WORKSPACE ROOT's own
// node_modules by default — `npx -p typescript -p typescript-language-server` does NOT help,
// because the two packages land in npx's own temp cache, which isn't on that resolution path
// (confirmed live: a fresh scratch repo with no node_modules failed with "Could not find a valid
// TypeScript installation" even with `-p typescript` present). The fix is passing an explicit
// `initializationOptions.tsserver.path` (an LSP-level option, not a CLI flag — there is no
// `--tsserver-path` flag on this server) pointing at a real `tsserver.js`. Rather than bundling
// `typescript` as a real (non-dev) dependency of turbollm itself — which would add real download
// weight to every `npx turbollm` install just for this — resolve it the same on-demand way the
// language server itself is resolved: ask npx for it once, cache the absolute path for the
// daemon's lifetime. This also means a target repo that already HAS `typescript` installed keeps
// using ITS OWN version first (workspace resolution is checked before this fallback — see
// findTypescriptVersion's own order in typescript-language-server's source), so pinned project
// versions are respected; this is only the fallback for repos that don't have one yet.
let cachedTsserverPath: Promise<string | null> | null = null
function resolveFallbackTsserverPath(): Promise<string | null> {
  if (!cachedTsserverPath) {
    cachedTsserverPath = new Promise((resolvePromise) => {
      const npxCmd = process.platform === 'win32' ? 'npx.cmd' : 'npx'
      const script = "process.stdout.write(require.resolve('typescript/lib/tsserver.js'))"
      const proc = spawn(npxCmd, ['-y', '-p', 'typescript', 'node', '-e', script], npxSpawnOptions())
      let out = ''
      proc.stdout?.on('data', (d) => { out += String(d) })
      const done = (result: string | null) => { clearTimeout(timer); resolvePromise(result) }
      proc.once('exit', (code) => done(code === 0 && out.trim() ? out.trim() : null))
      proc.once('error', () => done(null))
      const timer = setTimeout(() => done(null), TSSERVER_RESOLVE_TIMEOUT_MS)
    })
  }
  return cachedTsserverPath
}

export class LspClient {
  private proc: ChildProcessWithoutNullStreams | null = null
  private conn: MessageConnection | null = null
  private ready = false
  private startError: string | null = null
  private startPromise: Promise<{ ok: true } | { ok: false; error: string }> | null = null
  private readonly diagnosticsByUri = new Map<string, LspDiagnostic[]>()
  private readonly waitersByUri = new Map<string, Array<() => void>>()
  private readonly docVersionByUri = new Map<string, number>()

  constructor(private readonly spec: LspServerSpec, private readonly rootDir: string) {}

  /** Starts the server process and completes the initialize/initialized handshake, once. Safe to
   *  call repeatedly (idempotent) — concurrent callers share the same in-flight start. Never
   *  throws: a failed start is reported as `{ok: false, error}` so callers can skip diagnostics
   *  gracefully instead of blocking or crashing the agent turn. */
  async ensureStarted(): Promise<{ ok: true } | { ok: false; error: string }> {
    if (this.ready) return { ok: true }
    if (this.startError) return { ok: false, error: this.startError }
    if (this.startPromise) return this.startPromise
    this.startPromise = this.doStart()
    return this.startPromise
  }

  private async doStart(): Promise<{ ok: true } | { ok: false; error: string }> {
    try {
      // Resolved BEFORE spawning the actual server so a slow/failed resolution surfaces as part
      // of this same start attempt rather than a separate, confusing failure mid-initialize.
      // Only typescript-language-server needs this — see resolveFallbackTsserverPath's comment.
      const fallbackTsserverPath = this.spec.language === 'typescript' ? await resolveFallbackTsserverPath() : null

      const npxCmd = process.platform === 'win32' ? 'npx.cmd' : 'npx'
      const proc = spawn(npxCmd, this.spec.npxArgs, npxSpawnOptions(this.rootDir))
      this.proc = proc
      // A missing `npx` on PATH (or a killed process before it fully starts) fires 'error'
      // asynchronously — without this, a broken environment would just hang initialize forever.
      const spawnFailure = new Promise<string>((resolve) => {
        proc.once('error', (e) => resolve(e instanceof Error ? e.message : String(e)))
        proc.once('exit', (code) => { if (!this.ready) resolve(`server exited early (code ${code})`) })
      })

      const conn = createMessageConnection(new StreamMessageReader(proc.stdout), new StreamMessageWriter(proc.stdin))
      this.conn = conn
      conn.onNotification('textDocument/publishDiagnostics', (params: { uri: string; diagnostics: Array<{ range: { start: { line: number; character: number } }; message: string; severity?: number; source?: string }> }) => {
        const list: LspDiagnostic[] = params.diagnostics.map((d) => ({
          severity: SEVERITY_NAMES[d.severity ?? 1] ?? 'error',
          line: d.range.start.line + 1,
          character: d.range.start.character,
          message: d.message,
          source: d.source,
        }))
        this.diagnosticsByUri.set(params.uri, list)
        const waiters = this.waitersByUri.get(params.uri)
        if (waiters) { waiters.forEach((w) => w()); this.waitersByUri.delete(params.uri) }
      })
      conn.listen()

      const rootUri = toFileUri(this.rootDir)
      const initialize = conn.sendRequest('initialize', {
        processId: process.pid,
        rootUri,
        capabilities: { textDocument: { synchronization: { didSave: true }, publishDiagnostics: { relatedInformation: true } } },
        workspaceFolders: [{ uri: rootUri, name: 'workspace' }],
        // The target repo's own node_modules/typescript is tried FIRST by the server itself
        // (workspace resolution runs before this fallback path) — this only kicks in when the
        // repo doesn't have typescript installed yet, e.g. a brand-new project.
        ...(fallbackTsserverPath ? { initializationOptions: { tsserver: { path: fallbackTsserverPath } } } : {}),
      })
      const timeout = new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), INITIALIZE_TIMEOUT_MS))
      const result = await Promise.race([initialize.then(() => 'ok' as const), spawnFailure.then((e) => `error:${e}` as const), timeout])
      if (result === 'timeout') throw new Error(`${this.spec.language} language server did not initialize within ${INITIALIZE_TIMEOUT_MS}ms`)
      if (result.startsWith('error:')) throw new Error(result.slice('error:'.length))
      conn.sendNotification('initialized', {})
      this.ready = true
      return { ok: true }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      this.startError = msg
      this.dispose()
      return { ok: false, error: msg }
    }
  }

  /** Opens (or updates, if already open) `path` with `text` and waits up to DIAGNOSTICS_WAIT_MS
   *  for the server's next `publishDiagnostics` push for that file. A timeout returns whatever
   *  diagnostics are cached for the file (possibly stale or empty) rather than throwing — a slow
   *  or quiet server should never block the edit that triggered this. */
  async getDiagnostics(path: string, text: string): Promise<LspDiagnostic[]> {
    const started = await this.ensureStarted()
    if (!started.ok || !this.conn) return []
    const uri = toFileUri(path)
    const version = (this.docVersionByUri.get(uri) ?? 0) + 1
    this.docVersionByUri.set(uri, version)

    const waitForPush = new Promise<void>((resolve) => {
      const list = this.waitersByUri.get(uri) ?? []
      list.push(resolve)
      this.waitersByUri.set(uri, list)
    })

    if (version === 1) {
      this.conn.sendNotification('textDocument/didOpen', { textDocument: { uri, languageId: this.spec.languageId, version, text } })
    } else {
      this.conn.sendNotification('textDocument/didChange', { textDocument: { uri, version }, contentChanges: [{ text }] })
    }

    await Promise.race([waitForPush, new Promise<void>((resolve) => setTimeout(resolve, DIAGNOSTICS_WAIT_MS))])
    return this.diagnosticsByUri.get(uri) ?? []
  }

  dispose(): void {
    this.ready = false
    try { this.conn?.sendNotification('exit') } catch { /* best-effort */ }
    this.conn?.dispose()
    this.conn = null
    if (this.proc && !this.proc.killed) this.proc.kill()
    this.proc = null
  }
}
