// Tool registry (v0.7.0): aggregates built-in tools and MCP tool providers.
// Manages MCP server lifecycle and presents a unified tool list to the chat loop.
import type { McpServer, ToolsConfig } from '../config/config'
import {
  WEB_SEARCH_TOOL, FETCH_URL_TOOL, RUN_CODE_TOOL,
  execWebSearch, execFetchUrl, execRunCode, webSearchUnavailableMessage,
} from './builtin'
import { searchConfigured } from './search-providers'
import { createMcpClient, type IMcpClient } from './mcp-client'

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

  constructor(toolsCfg: ToolsConfig) {
    this.toolsCfg = toolsCfg
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
    if (searchConfigured(this.toolsCfg.search)) defs.push(WEB_SEARCH_TOOL)
    defs.push(FETCH_URL_TOOL)
    defs.push(RUN_CODE_TOOL)

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

  /** Execute a single tool call. Returns the result string. */
  async executeTool(call: ToolCall): Promise<string> {
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
