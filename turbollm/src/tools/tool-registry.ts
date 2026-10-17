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
import { ROUTINES_DISABLED_MESSAGE } from '../routines/routine-routes'
import { remoteGrantRequest } from '../auth'
import {
  LIST_AGENTS_TOOL, CREATE_AGENT_TOOL, execListAgents, execCreateAgent, type AgentToolsStore,
} from '../chat/chat-agent-tools'
import { LIST_MODELS_TOOL, execListModels, type ModelToolsStore } from '../models/model-tools'
import { isTextClassifierKey } from '../models/text-classifier'

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

const ROUTINE_TOOL_NAMES = new Set(['create_routine', 'list_routines', 'update_routine', 'delete_routine', 'run_routine_now'])
const REMOTE_GRANT_ROUTINES_MESSAGE = 'This access token is not allowed to manage routines. Use TurboLLM on the host.'
const REMOTE_GRANT_AGENTS_MESSAGE = 'This access token is not allowed to create chat agents. Use TurboLLM on the host.'
/** The refusal of an MCP server tool to a chat turn whose caller may not act on the host (see
 *  `refuseMcp`), worded like the MCP server routes' own refusal of the same callers. */
export const MCP_TOOLS_REFUSED_MESSAGE = 'Using an MCP server tool requires a valid API key from a non-host device.'

/** Is this an MCP server's tool (`mcp__{serverId}__{toolName}`, see buildToolDefinitions)? No
 *  built-in tool name starts with `mcp__`. */
export function isMcpToolName(name: string): boolean {
  return name.startsWith('mcp__')
}

/** Does this agent tool list name an MCP server tool? A chat routine runs every tool its agent
 *  lists with no approval (chat-runner.ts: interactive false, agentAllowedTools = agent.tools), so
 *  such a list is a standing approval to run the owner's MCP tool unattended. Writing one, and
 *  authoring, arming or running a chat routine on one, are therefore held to the bar adding the
 *  server is (isLocalOrAuthenticated): chat-agent-routes.ts, routine-routes.ts, and executeTool's
 *  create_agent and routine tools under `refuseMcp` or `refuseMcpAgentsAndRoutines`. */
export function listsMcpTool(tools: readonly string[]): boolean {
  return tools.some(isMcpToolName)
}
/** The refusal of an agent write that names an MCP server tool, or edits an agent that does. */
export const MCP_AGENT_REFUSED_MESSAGE = 'An agent that uses an MCP server tool can only be created or changed with a valid API key from a non-host device.'
/** The refusal of an approval of a pending MCP server tool call (chat and routine runs alike). */
export const MCP_APPROVAL_REFUSED_MESSAGE = 'Allowing an MCP server tool requires a valid API key from a non-host device.'
/** The refusal of a chat routine whose agent uses an MCP server tool. */
export const MCP_ROUTINE_REFUSED_MESSAGE = 'A routine whose agent uses an MCP server tool requires a valid API key from a non-host device.'

/** Everything a live MCP client is built from — a change to any of it needs a new client. */
function mcpFingerprint(srv: McpServer): string {
  return JSON.stringify([srv.name, srv.transport, srv.command, srv.args, srv.env, srv.url, srv.apiKey])
}

export class ToolRegistry {
  private toolsCfg: ToolsConfig
  private mcpClients = new Map<string, IMcpClient>()
  /** serverId -> the config its live client was built from (see mcpFingerprint). */
  private mcpFingerprints = new Map<string, string>()
  /** Tail of the serialized syncMcpServers chain (see syncMcpServers). */
  private mcpSync: Promise<void> = Promise.resolve()
  private routines?: RoutineToolsStore
  private runRoutineNowFn?: RunRoutineNowFn
  private agents?: AgentToolsStore
  private models?: ModelToolsStore
  private isRoutinesEnabled: () => boolean

  /** @param routines Injected once at boot (cli.ts passes `db` — a real ConversationStore
   *  structurally satisfies RoutineToolsStore). Absent means the 5 routine tools simply do not
   *  exist on this registry, which is what every test that constructs a bare ToolRegistry gets.
   *  @param runRoutineNow Backs `run_routine_now` — cli.ts binds RoutineScheduler.runNow.
   *  @param agents Injected once at boot (cli.ts passes `store` — a real ConfigStore structurally
   *  satisfies AgentToolsStore). Absent means list_agents/create_agent simply do not exist,
   *  same "no store, no tools" convention as `routines`.
   *  @param models Injected once at boot (cli.ts passes `scanner` — a real Scanner structurally
   *  satisfies ModelToolsStore). Absent means list_models simply does not exist, same convention.
   *  @param routinesEnabled Live check for `daemon.experimental.routines` (config.ts) — a getter,
   *  not a snapshot value, since Settings → Experimental can flip it without a restart and this
   *  registry is constructed once for the daemon's whole lifetime. Consulted ONLY for
   *  `create_routine` (both here and in the in-app Code/pi session, which reaches this same
   *  `create_routine` branch via `executeTool` — code-session.ts registers the tool
   *  unconditionally and always calls through here). list_routines/update_routine/delete_routine/
   *  run_routine_now stay unaffected, mirroring `ROUTINES_DISABLED_MESSAGE`'s own doc comment.
   *  Defaults to always-enabled so every pre-existing test/call site that doesn't know about this
   *  experimental gate keeps its exact previous behavior. */
  constructor(
    toolsCfg: ToolsConfig, routines?: RoutineToolsStore, runRoutineNow?: RunRoutineNowFn,
    agents?: AgentToolsStore, models?: ModelToolsStore, routinesEnabled?: () => boolean,
  ) {
    this.toolsCfg = toolsCfg
    this.routines = routines
    this.runRoutineNowFn = runRoutineNow
    this.agents = agents
    this.models = models
    this.isRoutinesEnabled = routinesEnabled ?? (() => true)
  }

  /** Does this key name a text classification model (Jev or Laya)? One labels or scores text: it can
   *  neither chat nor run a routine (ADR-434 (f), ADR-444), so the tool path refuses it in the same
   *  words the REST route does. Undefined when no models store was injected, which leaves the check off. */
  private textClassifierPredicate(): ((key: string) => boolean) | undefined {
    const models = this.models
    if (!models) return undefined
    return (key: string) => isTextClassifierKey(models.list().models, key)
  }

  /** Update config (called on settings change without restart). */
  updateConfig(toolsCfg: ToolsConfig): void {
    this.toolsCfg = toolsCfg
  }

  /** Connect/disconnect MCP servers to match the current config list. Serialized: the boot sync
   *  (cli.ts, which can take tens of seconds) and a sync from an MCP add/edit/toggle/delete would
   *  otherwise both see a still-connecting server as missing, spawn it twice, and orphan one. */
  syncMcpServers(servers: McpServer[]): Promise<void> {
    const run = this.mcpSync.then(() => this.doSyncMcpServers(servers))
    this.mcpSync = run.catch(() => {})
    return run
  }

  private async doSyncMcpServers(servers: McpServer[]): Promise<void> {
    const enabled = new Map(servers.filter((s) => s.enabled).map((s) => [s.id, s]))

    // Disconnect removed/disabled servers, and servers whose config was edited since their client
    // was built — the connect loop below then rebuilds those from the new config.
    for (const [id, client] of this.mcpClients) {
      const srv = enabled.get(id)
      if (!srv || this.mcpFingerprints.get(id) !== mcpFingerprint(srv)) {
        client.disconnect()
        this.mcpClients.delete(id)
        this.mcpFingerprints.delete(id)
      }
    }

    // Connect newly enabled servers
    for (const srv of servers) {
      if (!srv.enabled || this.mcpClients.has(srv.id)) continue
      try {
        const client = createMcpClient(srv)
        await client.connect()
        this.mcpClients.set(srv.id, client)
        this.mcpFingerprints.set(srv.id, mcpFingerprint(srv))
      } catch {
        // Non-fatal: MCP server failed to connect; it won't appear in tool list
      }
    }
  }

  disconnectAll(): void {
    for (const client of this.mcpClients.values()) client.disconnect()
    this.mcpClients.clear()
    this.mcpFingerprints.clear()
  }

  /** Build the full tools array to send to the engine. Returns [] when no tools are available.
   *  `forGeneration`: the list offered to the model in THIS request's generation, so tools its
   *  caller may not run are left out (a remote-access token's routine tools and create_agent;
   *  executeTool refuses them). Without it this is also the tool catalog (GET /api/v1/tools) an
   *  agent's saved allow-list is picked from, which must not depend on who asks.
   *  `refuseMcp`: leave out every MCP server tool, which executeTool then refuses too. Live chat
   *  sets it for a turn whose caller may not act on the host (see executeTool). */
  async buildToolDefinitions(opts: { forGeneration?: boolean; refuseMcp?: boolean } = {}): Promise<ToolDefinition[]> {
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
    // A remote-access token's generation gets none of them: every /api/v1/routines route refuses
    // it (no capability maps there), and these reach the same routines (see executeTool). The
    // catalog keeps them (see forGeneration).
    if (this.routines && !(opts.forGeneration && remoteGrantRequest())) {
      // create_routine alone is withheld from the model entirely while the experimental flag is
      // off — not just an error when called — so a model never even attempts to author one.
      if (this.isRoutinesEnabled()) defs.push(CREATE_ROUTINE_TOOL)
      defs.push(LIST_ROUTINES_TOOL, UPDATE_ROUTINE_TOOL, DELETE_ROUTINE_TOOL, RUN_ROUTINE_NOW_TOOL)
    }
    // Agent tools (Customize -> Agents) — lets a chat-flavor create_routine call be preceded by
    // list_agents/create_agent in the SAME turn, with no human needing to open Customize first.
    // A remote-access token's generation is offered list_agents only (see executeTool).
    if (this.agents) {
      defs.push(LIST_AGENTS_TOOL)
      if (!(opts.forGeneration && remoteGrantRequest())) defs.push(CREATE_AGENT_TOOL)
    }
    // Model tool — lets create_routine's modelKey be looked up instead of guessed. Real modelKeys
    // are compound ids (e.g. "gemma 4 26b a4b qat|Q4_0|14439362752"); without this, a model has no
    // data to work from and reaches for a generic cloud-model name like "gpt-4" or "claude" — a
    // routine created with a nonexistent modelKey can never fire successfully.
    if (this.models) {
      defs.push(LIST_MODELS_TOOL)
    }

    // MCP tools from connected servers
    for (const client of opts.refuseMcp ? [] : this.mcpClients.values()) {
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
   *  scheduled routine's unattended tool loop deliberately leaves it false.
   *
   *  @param opts.refuseMcp Refuse every MCP server tool. An MCP server runs with the owner's
   *  credentials (a stdio one is a command on this machine, often a filesystem or shell server),
   *  and adding one needs isLocalOrAuthenticated (POST /api/v1/mcp/servers). Live chat sets this
   *  for a turn whose caller fails that same bar (`!isCodeAuthorized`: a keyless Serve identity,
   *  Access JWT or open-LAN peer, or a remote-access token); without it such a caller had the model
   *  call the owner's MCP tools and approved the call itself. It also refuses create_agent with an
   *  MCP tool, and create_routine/update_routine/run_routine_now on a chat routine whose agent lists
   *  one (see listsMcpTool), which would otherwise run that tool for the same caller unapproved. A
   *  separate opt-in rather than isCodeAuthorized itself: Code (behind codeAuth), a scheduled
   *  routine and the External Chat API (owner-allowed tools only) call MCP tools with
   *  isCodeAuthorized at its false default, and refusing MCP on that default would take the tools
   *  away from them.
   *
   *  @param opts.refuseMcpAgentsAndRoutines Only the second half of `refuseMcp` (which implies it):
   *  the create_agent and routine-tool refusals, while MCP tools themselves still run. A routine's
   *  unattended run sets it (chat-runner.ts), as it leaves isCodeAuthorized false for code
   *  routines: it has no caller to check, and whoever created or approved a step of it may be one
   *  `refuseMcp` covers. Without it such a caller's routine on a plain agent listing
   *  update_routine and run_routine_now rewrote the owner's MCP routine's prompt and fired it. */
  async executeTool(call: ToolCall, isCodeAuthorized = false, opts: { refuseMcp?: boolean; refuseMcpAgentsAndRoutines?: boolean } = {}): Promise<string> {
    const name = call.name
    const args = call.args
    const refuseMcpAgentsAndRoutines = !!(opts.refuseMcp || opts.refuseMcpAgentsAndRoutines)

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
      // A remote-access token is refused every /api/v1/routines route (auth.ts requiredCapability
      // maps none there), and the chat tool loop runs inside that token's own request. Without
      // this, a models:use token could repoint an active routine's modelKey and leave the
      // scheduler to load it, or rewrite, run or delete the owner's routines.
      if (ROUTINE_TOOL_NAMES.has(name) && remoteGrantRequest()) return `Error: ${REMOTE_GRANT_ROUTINES_MESSAGE}`
      // A chat routine runs its agent's tools with no approval (see listsMcpTool), so a turn whose
      // caller may not use the owner's MCP tools itself may not author, edit or fire one on an
      // agent that lists them: the same refusal POST/PUT /api/v1/routines and /run-now give it.
      // Without this the chat routes' own MCP refusal was undone by update_routine + run_routine_now
      // on the owner's routine in that same chat. A routine's own run is refused it too (see
      // refuseMcpAgentsAndRoutines).
      const mcpRoutine = refuseMcpAgentsAndRoutines && this.chatRoutineUsesMcp(name, args)
      if (name === 'create_routine') {
        // Experimental gate first, exactly like POST /api/v1/routines (routine-routes.ts) checks
        // it before even the code-flavor gate — off means off for every flavor, on every surface
        // that reaches this branch (chat's own tool loop AND the in-app Code/pi session, which
        // both call executeTool with name: 'create_routine').
        if (!this.isRoutinesEnabled()) return `Error: ${ROUTINES_DISABLED_MESSAGE}`
        if (mcpRoutine) return `Error: ${MCP_ROUTINE_REFUSED_MESSAGE}`
        const modelExists = this.models ? (key: string) => this.models!.list().models.some((m) => m.key === key) : undefined
        return execCreateRoutine(args, this.routines, isCodeAuthorized, modelExists, this.textClassifierPredicate())
      }
      if (name === 'list_routines') return execListRoutines(args, this.routines)
      if (name === 'update_routine') {
        if (mcpRoutine) return `Error: ${MCP_ROUTINE_REFUSED_MESSAGE}`
        return execUpdateRoutine(args, this.routines, isCodeAuthorized, this.textClassifierPredicate())
      }
      if (name === 'delete_routine') return execDeleteRoutine(args, this.routines)
      if (name === 'run_routine_now') {
        // Same kill switch as create_routine — RoutineScheduler.runNow() (cli.ts's injected
        // runRoutineNowFn) checks this same flag independently, so this is a clearer error
        // message on this surface rather than the only enforcement.
        if (!this.isRoutinesEnabled()) return `Error: ${ROUTINES_DISABLED_MESSAGE}`
        if (!this.runRoutineNowFn) return 'Error: run_routine_now is not available in this build.'
        if (mcpRoutine) return `Error: ${MCP_ROUTINE_REFUSED_MESSAGE}`
        return execRunRoutineNow(args, this.routines, this.runRoutineNowFn, isCodeAuthorized)
      }
    }

    // Agent tools (Customize -> Agents) — unlike the routine tools, not gated on Code
    // authorization: see chat-agent-tools.ts's module header for why a CustomChatAgent carries no
    // more risk than the model composing a longer reply, and for its one exception (an MCP tool).
    if (this.agents) {
      if (name === 'list_agents') return execListAgents(args, this.agents)
      if (name === 'create_agent') {
        // A remote-access token may read the agents (GET /api/v1/chat-agents is models:use) but
        // not write one: POST /api/v1/chat-agents needs config:write (auth.ts requiredCapability),
        // which no token the remote-access UI mints carries (remote/routes.ts sanitizeTokenGrant).
        // The chat tool loop runs inside that token's own request, so without this a models:use
        // token, approving its own call, added agents with any system prompt and tool list.
        if (remoteGrantRequest()) return `Error: ${REMOTE_GRANT_AGENTS_MESSAGE}`
        // POST /api/v1/chat-agents's MCP refusal (see listsMcpTool): an agent listing the owner's
        // MCP tool is what a chat routine then runs it under, with no approval.
        if (refuseMcpAgentsAndRoutines && Array.isArray(args.tools) && listsMcpTool(args.tools.filter((t): t is string => typeof t === 'string'))) {
          return `Error: ${MCP_AGENT_REFUSED_MESSAGE}`
        }
        return execCreateAgent(args, this.agents)
      }
    }

    // Model tool — read-only, no gating needed (same reasoning as list_agents: it only ever
    // reveals what's already visible in the Models screen).
    if (this.models) {
      if (name === 'list_models') return execListModels(args, this.models)
    }

    // MCP tool: mcp__{serverId}__{toolName}
    if (opts.refuseMcp && isMcpToolName(name)) return `Error: ${MCP_TOOLS_REFUSED_MESSAGE}`
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

  /** Would this routine tool call author, edit or fire a chat routine whose agent lists an MCP
   *  server tool? create_routine names the agent in its args; update_routine and run_routine_now
   *  act on a stored routine, whose agent cannot change. The agents store is the ConfigStore
   *  chat-runner.ts resolves a routine's agent from; a registry built without one has none. */
  private chatRoutineUsesMcp(name: string, args: Record<string, unknown>): boolean {
    let flavor: unknown
    let agentId: unknown
    if (name === 'create_routine') {
      flavor = args.flavor
      agentId = args.agentId
    } else if (name === 'update_routine' || name === 'run_routine_now') {
      const routine = this.routines?.getRoutine(String(args.routineId ?? '').trim())
      flavor = routine?.flavor
      agentId = routine?.agentId
    } else {
      return false
    }
    if (flavor !== 'chat') return false
    const agent = this.agents?.snapshot().customAgents.find((a) => a.id === agentId)
    return !!agent && listsMcpTool(agent.tools)
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
