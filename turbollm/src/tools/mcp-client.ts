// MCP host/client. Implements stdio (subprocess JSON-RPC) and Streamable HTTP
// (MCP 2025-03-26) transports. All modern hosted MCPs use Streamable HTTP.
import { spawn, type ChildProcess } from 'node:child_process'

// ── MCP protocol types ────────────────────────────────────────────────────

interface JsonRpcRequest {
  jsonrpc: '2.0'
  id: string | number
  method: string
  params?: unknown
}

interface JsonRpcResponse {
  jsonrpc: '2.0'
  id: string | number
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

interface JsonRpcNotification {
  jsonrpc: '2.0'
  method: string
  params?: unknown
}

export interface McpTool {
  name: string
  description?: string
  inputSchema?: Record<string, unknown>
}

export interface McpCallResult {
  content: Array<{ type: string; text?: string }>
  isError?: boolean
}

// ── Base client interface ─────────────────────────────────────────────────

export interface IMcpClient {
  readonly serverId: string
  readonly serverName: string
  connect(): Promise<void>
  disconnect(): void
  listTools(): Promise<McpTool[]>
  callTool(name: string, args: Record<string, unknown>): Promise<string>
}

// ── Stdio client ──────────────────────────────────────────────────────────

export class StdioMcpClient implements IMcpClient {
  readonly serverId: string
  readonly serverName: string
  private command: string
  private args: string[]
  private env: Record<string, string>
  private proc: ChildProcess | null = null
  private pending = new Map<string | number, { resolve: (r: JsonRpcResponse) => void }>()
  private buf = ''
  private msgId = 0
  private initialized = false

  constructor(opts: { id: string; name: string; command: string; args?: string[]; env?: Record<string, string> }) {
    this.serverId = opts.id
    this.serverName = opts.name
    this.command = opts.command
    this.args = opts.args ?? []
    this.env = opts.env ?? {}
  }

  async connect(): Promise<void> {
    if (this.proc) return
    // npx/uvx are .cmd shims on Windows; Node refuses to spawn .cmd directly (CVE-2024-27980)
    // and won't resolve them via PATHEXT without a shell. Instead of shell:true with a
    // concatenated string (DEP0190 + shell-injection surface from custom commands), run the
    // invocation through `cmd.exe /c` with a DISCRETE args array (shell:false). Node escapes
    // each arg, so whitespace and metacharacters in args are not re-interpreted by a shell.
    // On POSIX the command is on PATH and runs directly.
    const isWin = process.platform === 'win32'
    const file = isWin ? 'cmd.exe' : this.command
    const args = isWin ? ['/c', this.command, ...this.args] : this.args
    const proc = spawn(file, args, {
      env: { ...process.env, ...this.env },
      // stderr is discarded, not piped: nothing reads it, and once an unread pipe fills (~128 KB of
      // logging — the Python MCP SDK logs every request at INFO) the server blocks on its next
      // stderr write and every later request times out.
      stdio: ['pipe', 'pipe', 'ignore'],
    })
    this.proc = proc
    this.buf = ''

    // Every handler below acts only while `proc` is still THE process. After a failed initialize
    // or a disconnect the old process is killed, not awaited, and the next call lazily spawns a
    // replacement: the old one's late 'exit'/'error' would otherwise kill that replacement and
    // fail its pending requests, and its last buffered stdout would splice into the new stream.
    // Decoded by the stream, not chunk by chunk: a multibyte character split across two pipe
    // reads (~64 KB each) would otherwise become U+FFFD on both sides, inside a JSON string that
    // still parses, so a large tool result reached the model silently altered.
    proc.stdout?.setEncoding('utf8')
    proc.stdout?.on('data', (chunk: string) => {
      if (this.proc !== proc) return
      this.buf += chunk
      const lines = this.buf.split('\n')
      this.buf = lines.pop() ?? ''
      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed) continue
        try {
          const msg = JSON.parse(trimmed) as JsonRpcResponse | JsonRpcNotification
          if ('id' in msg && msg.id != null) {
            const pending = this.pending.get(msg.id)
            if (pending) {
              this.pending.delete(msg.id)
              pending.resolve(msg as JsonRpcResponse)
            }
          }
        } catch { /* ignore parse errors */ }
      }
    })

    proc.on('error', () => { if (this.proc === proc) this.cleanup() })
    proc.on('exit', () => { if (this.proc === proc) this.cleanup() })

    try {
      await this.sendRequest('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        clientInfo: { name: 'turbollm', version: '0.7.0' },
      })
    } catch (e) {
      // A rejected or timed-out initialize (a first-run `npx -y`/`uvx` download easily outlasts
      // the 30 s timeout) must not leave the child running: the caller drops this client, so
      // nothing else would ever kill it, and the next sync spawns another. (Unless `proc` is
      // already gone and cleaned up — then this.proc may be a replacement that is not ours to kill.)
      if (this.proc === proc) this.cleanup()
      throw e
    }
    await this.sendNotification('notifications/initialized', {})
    this.initialized = true
  }

  disconnect(): void {
    this.cleanup()
  }

  async listTools(): Promise<McpTool[]> {
    if (!this.initialized) await this.connect()
    const result = await this.sendRequest('tools/list', {}) as { tools?: McpTool[] }
    return result.tools ?? []
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    if (!this.initialized) await this.connect()
    const result = await this.sendRequest('tools/call', { name, arguments: args }) as McpCallResult
    const text = (result.content ?? [])
      .filter((c) => c.type === 'text' && c.text)
      .map((c) => c.text!)
      .join('\n')
    return result.isError ? `Error: ${text}` : (text || '(no output)')
  }

  private sendRequest(method: string, params: unknown): Promise<unknown> {
    const id = ++this.msgId
    const req: JsonRpcRequest = { jsonrpc: '2.0', id, method, params }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`MCP request timeout: ${method}`))
      }, 30_000)
      this.pending.set(id, {
        resolve: (r) => {
          clearTimeout(timer)
          if (r.error) reject(new Error(r.error.message))
          else resolve(r.result)
        },
      })
      this.write(req)
    })
  }

  private sendNotification(method: string, params: unknown): void {
    const msg: JsonRpcNotification = { jsonrpc: '2.0', method, params }
    this.write(msg)
  }

  private write(msg: unknown): void {
    if (!this.proc?.stdin?.writable) return
    try {
      this.proc.stdin.write(JSON.stringify(msg) + '\n')
    } catch { /* ignore write errors on disconnected proc */ }
  }

  private cleanup(): void {
    for (const p of this.pending.values()) {
      p.resolve({ jsonrpc: '2.0', id: -1, error: { code: -1, message: 'MCP server disconnected' } })
    }
    this.pending.clear()
    try { this.proc?.kill() } catch { /* ignore */ }
    this.proc = null
    this.initialized = false
  }
}

// ── Streamable HTTP client (MCP 2025-03-26) ───────────────────────────────────
// Modern hosted MCPs (GitHub, Linear, Stripe, Atlassian, Neon, etc.) use this
// transport: POST every JSON-RPC message directly to the base URL; server
// replies with plain JSON or an SSE stream. Session ID is tracked via the
// Mcp-Session-Id response header and echoed on all subsequent requests.

export class SseMcpClient implements IMcpClient {
  readonly serverId: string
  readonly serverName: string
  private baseUrl: string
  private headers: Record<string, string>
  private msgId = 0
  private sessionId: string | null = null
  private initialized = false

  constructor(opts: { id: string; name: string; url: string; headers?: Record<string, string> }) {
    this.serverId = opts.id
    this.serverName = opts.name
    this.baseUrl = opts.url.replace(/\/$/, '')
    this.headers = opts.headers ?? {}
  }

  async connect(): Promise<void> {
    if (this.initialized) return
    // protocolVersion is the MCP message-protocol version (distinct from the Streamable HTTP
    // transport). 2024-11-05 is the broadest version every hosted server accepts; servers that
    // prefer a newer one negotiate down, so this stays maximally compatible.
    await this.sendRequest('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      clientInfo: { name: 'turbollm', version: '0.7.0' },
    })
    void this.postNotification({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })
    this.initialized = true
  }

  disconnect(): void {
    this.sessionId = null
    this.initialized = false
  }

  async listTools(): Promise<McpTool[]> {
    if (!this.initialized) await this.connect()
    const result = await this.sendRequest('tools/list', {}) as { tools?: McpTool[] }
    return result.tools ?? []
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    if (!this.initialized) await this.connect()
    const result = await this.sendRequest('tools/call', { name, arguments: args }) as McpCallResult
    const text = (result.content ?? [])
      .filter((c) => c.type === 'text' && c.text)
      .map((c) => c.text!)
      .join('\n')
    return result.isError ? `Error: ${text}` : (text || '(no output)')
  }

  private async sendRequest(method: string, params: unknown, retried = false): Promise<unknown> {
    const id = ++this.msgId
    const req: JsonRpcRequest = { jsonrpc: '2.0', id, method, params }
    const reqHeaders: Record<string, string> = {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      ...this.headers,
    }
    const sentSession = this.sessionId
    if (sentSession) reqHeaders['Mcp-Session-Id'] = sentSession

    const resp = await fetch(this.baseUrl, {
      method: 'POST',
      headers: reqHeaders,
      body: JSON.stringify(req),
      signal: AbortSignal.timeout(30_000),
    })

    // MCP 2025-03-26: a 404 to a request carrying a session id means the server ended that session
    // (restart, idle expiry) and the client MUST start a new one. Once per request, so a server
    // that keeps answering 404 still surfaces as an error below. (An initialize that carried a
    // stale id is simply resent without one — it IS the new session.)
    if (resp.status === 404 && sentSession && !retried) {
      await resp.body?.cancel().catch(() => {})
      if (this.sessionId === sentSession) {
        this.sessionId = null
        this.initialized = false
      }
      if (method !== 'initialize') await this.connect()
      return this.sendRequest(method, params, true)
    }

    if (!resp.ok) {
      const txt = await resp.text().catch(() => '')
      throw new Error(`MCP HTTP ${resp.status}: ${txt.slice(0, 200)}`)
    }

    const newSession = resp.headers.get('mcp-session-id')
    if (newSession) this.sessionId = newSession

    const ct = resp.headers.get('content-type') ?? ''
    if (ct.includes('text/event-stream')) return this.readSSEResult(resp, id)

    const json = await resp.json() as JsonRpcResponse
    if (json.error) throw new Error(json.error.message)
    return json.result
  }

  private async readSSEResult(resp: Response, targetId: string | number): Promise<unknown> {
    if (!resp.body) throw new Error('SSE response body is null')
    const reader = resp.body.getReader()
    const dec = new TextDecoder()
    let buf = ''
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buf += dec.decode(value, { stream: true })
        const lines = buf.split('\n')
        buf = lines.pop() ?? ''
        for (const line of lines) {
          if (!line.startsWith('data:')) continue
          let msg: JsonRpcResponse
          try {
            msg = JSON.parse(line.slice(5).trim()) as JsonRpcResponse
          } catch {
            continue // non-JSON SSE lines (comments, pings) — skip, don't swallow real errors
          }
          if (msg.id === targetId) {
            if (msg.error) throw new Error(msg.error.message)
            return msg.result
          }
        }
      }
    } finally {
      // Cancel (not just release) so the underlying connection is torn down once we have
      // our answer — releaseLock alone leaves the body streaming.
      await reader.cancel().catch(() => {})
    }
    throw new Error(`SSE stream ended without response for id ${targetId}`)
  }

  private async postNotification(msg: JsonRpcNotification): Promise<void> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json', ...this.headers }
    if (this.sessionId) headers['Mcp-Session-Id'] = this.sessionId
    await fetch(this.baseUrl, {
      method: 'POST', headers, body: JSON.stringify(msg),
      signal: AbortSignal.timeout(10_000),
    }).catch(() => {})
  }
}

// ── Factory ───────────────────────────────────────────────────────────────

export function createMcpClient(server: {
  id: string
  name: string
  transport: 'stdio' | 'sse'
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  apiKey?: string
}): IMcpClient {
  if (server.transport === 'sse') {
    if (!server.url) throw new Error(`MCP server "${server.name}" has transport=sse but no url`)
    const headers = server.apiKey ? { Authorization: `Bearer ${server.apiKey}` } : undefined
    return new SseMcpClient({ id: server.id, name: server.name, url: server.url, headers })
  }
  if (!server.command) throw new Error(`MCP server "${server.name}" has transport=stdio but no command`)
  return new StdioMcpClient({
    id: server.id, name: server.name,
    command: server.command, args: server.args, env: server.env,
  })
}
