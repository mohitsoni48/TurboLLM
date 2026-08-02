// Tool registry (v0.7.0): aggregates built-in tools and MCP tool providers.
// Manages MCP server lifecycle and presents a unified tool list to the chat loop.
import type { McpServer, ToolsConfig } from '../config/config'
import {
  webSearchTool, FETCH_URL_TOOL, RUN_CODE_TOOL,
  execWebSearch, execFetchUrl, execRunCode, webSearchUnavailableMessage,
} from './builtin'
import { searchConfigured } from './search-providers'
import { createMcpClient, type IMcpClient } from './mcp-client'
import {
  CREATE_ROUTINE_TOOL, LIST_ROUTINES_TOOL, UPDATE_ROUTINE_TOOL, DELETE_ROUTINE_TOOL, RUN_ROUTINE_NOW_TOOL,
  execCreateRoutine, execListRoutines, execUpdateRoutine, execDeleteRoutine, execRunRoutineNow,
  type RoutineToolsStore, type RunRoutineNowFn,
} from '../routines/routine-tools'

export interface ToolDefinition {
  type: 'function'
  function: {
    name: string
    description?: string
    parameters?: Record<string, unknown>
  }
}

export interface ToolCall {
  id: string
  name: string
  args: Record<string, unknown>
}

export class ToolRegistry {
  private toolsCfg: ToolsConfig
  private mcpClients = new Map<string, IMcpClient>()
  private routines?: RoutineToolsStore
  private runRoutineNowFn?: RunRoutineNowFn

  /** @param routines Injected once at boot (cli.ts passes `db` — a real ConversationStore
   *  structurally satisfies RoutineToolsStore). Absent means the 5 routine tools simply do not
   *  exist on this registry, which is what every test that constructs a bare ToolRegistry gets.
   *  @param runRoutineNow Backs `run_routine_now` — cli.ts binds RoutineScheduler.runNow. */
  constructor(toolsCfg: ToolsConfig, routines?: RoutineToolsStore, runRoutineNow?: RunRoutineNowFn) {
    this.toolsCfg = toolsCfg
    this.routines = routines
    this.runRoutineNowFn = runRoutineNow
  }

  /** Update config (called on settings change without restart). */
  updateConfig(toolsCfg: ToolsConfig): void {
    this.toolsCfg = toolsCfg
  }

  /** Connect/disconnect MCP servers to match the current config list. */
  async syncMcpServers(servers: McpServer[]): Promise<void> {
    const enabledIds = new Set(servers.filter((s) => s.enabled).map((s) => s.id))

    // Disconnect removed/disabled servers
    for (const [id, client] of this.mcpClients) {
      if (!enabledIds.has(id)) {
        client.disconnect()
        this.mcpClients.delete(id)
      }
    }

    // Connect newly enabled servers
    for (const srv of servers) {
      if (!srv.enabled || this.mcpClients.has(srv.id)) continue
      try {
        const client = createMcpClient(srv)
        await client.connect()
        this.mcpClients.set(srv.id, client)
      } catch {
        // Non-fatal: MCP server failed to connect; it won't appear in tool list
      }
    }
  }

  disconnectAll(): void {
    for (const client of this.mcpClients.values()) client.disconnect()
    this.mcpClients.clear()
  }

  /** Build the full tools array to send to the engine. Returns [] when no tools are available. */
  async buildToolDefinitions(): Promise<ToolDefinition[]> {
    const defs: ToolDefinition[] = []

    // Built-in tools — only available when the required config is present
    // Built fresh per request so its embedded date is today's, not the daemon's start date.
    if (searchConfigured(this.toolsCfg.search)) defs.push(webSearchTool())
    defs.push(FETCH_URL_TOOL)
    defs.push(RUN_CODE_TOOL)
    // Routine tools (Phase 4) — gated on whether a RoutineToolsStore was actually injected
    // (production always injects one via cli.ts; tests that construct a bare ToolRegistry to
    // exercise fetch_url/run_code/MCP behavior are unaffected). Persona scoping is NOT done
    // here — it's the same downstream conv.allowedTools filter every other built-in already
    // goes through (chat-routes.ts), identical to fetch_url/run_code/web_search.
    if (this.routines) {
      defs.push(CREATE_ROUTINE_TOOL, LIST_ROUTINES_TOOL, UPDATE_ROUTINE_TOOL, DELETE_ROUTINE_TOOL, RUN_ROUTINE_NOW_TOOL)
    }

    // MCP tools from connected servers
    for (const client of this.mcpClients.values()) {
      try {
        const mcpTools = await client.listTools()
        for (const t of mcpTools) {
          defs.push({
            type: 'function',
            function: {
              name: `mcp__${client.serverId.replace(/-/g, '_')}__${t.name}`,
              description: `[${client.serverName}] ${t.description ?? ''}`,
              parameters: t.inputSchema ?? { type: 'object', properties: {} },
            },
          })
        }
      } catch { /* skip unavailable MCP server */ }
    }

    return defs
  }

  /** Execute a single tool call. Returns the result string.
   *
   *  @param isCodeAuthorized The CALLER's per-request answer to "has this caller cleared the same
   *  bar `codeAuth` enforces — host-local OR holding a valid API key?". Consulted by
   *  `create_routine`/`update_routine`/`run_routine_now`, and only for CODE-flavor routines (see
   *  routine-tools.ts's module header; `delete_routine`/`list_routines` are deliberately ungated
   *  there, for REST parity). It cannot be computed here: this registry is constructed ONCE for the
   *  daemon's whole lifetime (cli.ts), while the answer is a property of one specific HTTP
   *  request. DEFAULTS TO FALSE so a caller that does not know about this gate — every pre-Phase-4
   *  call site, and any future one — blocks code-flavor authoring rather than silently permitting
   *  it. Chat's live handler computes it with routine-routes.ts's own `codeGateBlocks`; a
   *  scheduled routine's unattended tool loop deliberately leaves it false. */
  async executeTool(call: ToolCall, isCodeAuthorized = false): Promise<string> {
    const name = call.name
    const args = call.args

    // Built-in: web_search (provider chosen via tools.search — F-020)
    if (name === 'web_search') {
      if (!searchConfigured(this.toolsCfg.search)) {
        // Reachable only when a model calls web_search despite it being absent from the tool
        // list (buildToolDefinitions omits it when unconfigured) — small models do hallucinate
        // tool names. The old text just named the misconfiguration; it did not tell the model
        // what to DO, so a Research turn could still narrate a search it never ran. This says
        // "you cannot search, disclose that" instead. Same wording the system-prompt path uses.
        return `Error: ${webSearchUnavailableMessage('not_configured')}`
      }
      return execWebSearch(args, this.toolsCfg.search!)
    }

    // Built-in: fetch_url
    if (name === 'fetch_url') return execFetchUrl(args)

    // Built-in: run_code — approval gating happens upstream in execute-with-approval.ts
    // before executeTool is ever called, so run_code always executes here.
    if (name === 'run_code') return execRunCode(args)

    // Routine tools (Phase 4) — the same shared executors chat and the in-app Code/pi session
    // both reach (code-session.ts calls THIS method too, not a second implementation).
    if (this.routines) {
      if (name === 'create_routine') return execCreateRoutine(args, this.routines, isCodeAuthorized)
      if (name === 'list_routines') return execListRoutines(args, this.routines)
      if (name === 'update_routine') return execUpdateRoutine(args, this.routines, isCodeAuthorized)
      if (name === 'delete_routine') return execDeleteRoutine(args, this.routines)
      if (name === 'run_routine_now') {
        if (!this.runRoutineNowFn) return 'Error: run_routine_now is not available in this build.'
        return execRunRoutineNow(args, this.routines, this.runRoutineNowFn, isCodeAuthorized)
      }
    }

    // MCP tool: mcp__{serverId}__{toolName}
    const mcpMatch = name.match(/^mcp__([^_]+(?:_[^_]+)*)__(.+)$/)
    if (mcpMatch) {
      const rawServerId = mcpMatch[1].replace(/_/g, '-')
      const toolName = mcpMatch[2]

      // Find the client — try exact match first, then normalized
      let client = this.mcpClients.get(rawServerId)
      if (!client) {
        // Brute-force search since ID normalization is lossy
        for (const [id, c] of this.mcpClients) {
          if (id.replace(/-/g, '_') === mcpMatch[1]) { client = c; break }
        }
      }
      if (!client) return `Error: MCP server "${rawServerId}" not connected.`
      return client.callTool(toolName, args)
    }

    return `Error: unknown tool "${name}"`
  }

  /** Whether web_search can actually execute (a provider is configured). Distinct from whether
   *  the model can REACH it — the tool list may still be suppressed downstream (see the
   *  engine-kind gate in chat-routes.ts). Callers that need to explain a failed research turn
   *  use this to pick between the 'not_configured' and 'tools_unreachable' reasons. */
  searchAvailable(): boolean {
    return searchConfigured(this.toolsCfg.search)
  }

  /** Whether any tools are currently available (determines if tools should be sent to engine). */
  hasTools(): boolean {
    if (searchConfigured(this.toolsCfg.search)) return true
    if (this.mcpClients.size > 0) return true
    // fetch_url and run_code are always available
    return true
  }
}
