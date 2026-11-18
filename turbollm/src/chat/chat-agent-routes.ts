// Custom chat Agent HTTP routes (Customize → Agents). A chat agent is a named
// system prompt with a skill + tool allow-list, selected when starting a new
// conversation — separate from the built-in personas (frontend-only) and from
// the background pi-agent-run schema (config.agents).
//   GET    /api/v1/chat-agents                        — list CustomChatAgent[]
//   POST   /api/v1/chat-agents                        — create
//   PUT    /api/v1/chat-agents/:id                     — update
//   DELETE /api/v1/chat-agents/:id                     — delete
//   GET    /api/v1/chat-agents/builtin-overrides       — map of built-in id → override
//   PUT    /api/v1/chat-agents/builtin-overrides/:id   — save/replace a built-in's override
//   DELETE /api/v1/chat-agents/builtin-overrides/:id   — reset a built-in to its default
import type { Hono } from 'hono'
import { randomUUID } from 'node:crypto'
import type { Deps } from '../deps'
import type { CustomChatAgent, BuiltinAgentOverride } from '../config/config'
import { isLocalOrAuthenticated } from '../auth'
import { listsMcpTool, MCP_AGENT_REFUSED_MESSAGE } from '../tools/tool-registry'
import { body } from '../api/http'
import { nonStringField } from '../util/string-fields'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function err(c: any, status: number, code: string, message: string) {
  return c.json({ error: { code, message } }, status)
}


const AGENT_CAP = 50

/** The 400 message for an agent body whose fields are not the types the routes trim and store: a number, object or array
 *  in name/description/systemPrompt threw (`.trim is not a function`, a config.json the validator then refused), and a
 *  skillIds/tools that was not an array of strings was read as "none" (sanitizeStringArray), so `tools: "web_search"` or
 *  `tools: [7]` silently left the agent with no tools. Absent and null fields are left as they are: the edit routes
 *  read null as absent, as the create route already did (`?.`, `??`), where `name: null` used to throw. */
function agentFieldsError(b: object): string | undefined {
  const text = nonStringField(b, ['name', 'description', 'systemPrompt'])
  if (text) return `${text} must be a string.`
  const lists = b as Record<string, unknown>
  const list = ['skillIds', 'tools'].find((f) => lists[f] != null && !(Array.isArray(lists[f]) && (lists[f] as unknown[]).every((x) => typeof x === 'string')))
  return list ? `${list} must be an array of strings.` : undefined
}

function sanitizeStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
}

export function registerChatAgentRoutes(app: Hono, d: Deps): void {
  // Built-in overrides — registered before the /:id routes below (literal segments
  // take precedence, but this keeps the two resources visually separate too).
  app.get('/api/v1/chat-agents/builtin-overrides', (c) => c.json(d.store.snapshot().builtinAgentOverrides))

  // No MCP-tool rule here, unlike the custom-agent routes below: a built-in agent never backs a
  // routine (chat-runner.ts resolves customAgents only), and a live chat offers MCP tools only to a
  // turn whose caller may use them (chat-routes.ts refuseMcp), under the owner's tool policies.
  app.put('/api/v1/chat-agents/builtin-overrides/:id', async (c) => {
    const id = c.req.param('id')
    if (!id.trim()) return err(c, 400, 'invalid_config_value', 'id is required.')
    const b = await body<BuiltinAgentOverride>(c)
    const invalid = agentFieldsError(b)
    if (invalid) return err(c, 400, 'invalid_config_value', invalid)
    const override: BuiltinAgentOverride = {}
    if (b.name != null) override.name = b.name.trim()
    if (b.description != null) override.description = b.description.trim()
    if (b.systemPrompt != null) override.systemPrompt = b.systemPrompt
    if (b.skillIds != null) override.skillIds = sanitizeStringArray(b.skillIds)
    if (b.tools != null) override.tools = sanitizeStringArray(b.tools)
    if (Object.keys(d.store.snapshot().builtinAgentOverrides).length >= AGENT_CAP && !(id in d.store.snapshot().builtinAgentOverrides)) {
      return err(c, 400, 'too_many_agents', `Override limit reached (${AGENT_CAP}).`)
    }
    d.store.update((cfg) => { cfg.builtinAgentOverrides[id] = override })
    return c.json(override)
  })

  app.delete('/api/v1/chat-agents/builtin-overrides/:id', (c) => {
    const id = c.req.param('id')
    d.store.update((cfg) => { delete cfg.builtinAgentOverrides[id] })
    return c.json({ ok: true })
  })

  app.get('/api/v1/chat-agents', (c) => c.json(d.store.snapshot().customAgents))

  app.post('/api/v1/chat-agents', async (c) => {
    const b = await body<Partial<CustomChatAgent>>(c)
    // A chat routine runs every tool its agent lists with no approval (chat-runner.ts), so an
    // agent naming the owner's MCP tool is a standing approval to run it: the isLocalOrAuthenticated
    // bar adding the MCP server has (listsMcpTool). Without it a keyless Serve identity, Access JWT
    // or open-LAN peer, or a config:write remote token, refused the tool in its own chat, saved it
    // here and had a chat routine run it. api_key_required: the web client opens its key prompt.
    if (listsMcpTool(sanitizeStringArray(b.tools)) && !isLocalOrAuthenticated(c, d)) {
      return err(c, 403, 'api_key_required', MCP_AGENT_REFUSED_MESSAGE)
    }
    const invalid = agentFieldsError(b)
    if (invalid) return err(c, 400, 'invalid_config_value', invalid)
    if (!b.name?.trim()) return err(c, 400, 'invalid_config_value', 'name is required.')
    if (d.store.snapshot().customAgents.length >= AGENT_CAP) {
      return err(c, 400, 'too_many_agents', `Agent limit reached (${AGENT_CAP}).`)
    }
    const agent: CustomChatAgent = {
      id: randomUUID(),
      name: b.name.trim(),
      description: b.description?.trim() ?? '',
      systemPrompt: b.systemPrompt ?? '',
      skillIds: sanitizeStringArray(b.skillIds),
      tools: sanitizeStringArray(b.tools),
    }
    d.store.update((cfg) => { cfg.customAgents.push(agent) })
    return c.json(agent, 201)
  })

  app.put('/api/v1/chat-agents/:id', async (c) => {
    const id = c.req.param('id')
    const existing = d.store.snapshot().customAgents.find((a) => a.id === id)
    if (!existing) {
      return err(c, 404, 'not_found', 'Agent not found.')
    }
    const b = await body<Partial<CustomChatAgent>>(c)
    // Same rule as the create route, for an edit that adds an MCP tool and for any edit of an agent
    // that has one: its system prompt and skills are what a chat routine runs that tool under.
    if ((listsMcpTool(existing.tools) || listsMcpTool(sanitizeStringArray(b.tools))) && !isLocalOrAuthenticated(c, d)) {
      return err(c, 403, 'api_key_required', MCP_AGENT_REFUSED_MESSAGE)
    }
    const invalid = agentFieldsError(b)
    if (invalid) return err(c, 400, 'invalid_config_value', invalid)
    if (b.name != null && !b.name.trim()) return err(c, 400, 'invalid_config_value', 'name is required.')
    d.store.update((cfg) => {
      const a = cfg.customAgents.find((x) => x.id === id)!
      if (b.name != null) a.name = b.name.trim()
      if (b.description != null) a.description = b.description.trim()
      if (b.systemPrompt != null) a.systemPrompt = b.systemPrompt
      if (b.skillIds != null) a.skillIds = sanitizeStringArray(b.skillIds)
      if (b.tools != null) a.tools = sanitizeStringArray(b.tools)
    })
    return c.json(d.store.snapshot().customAgents.find((a) => a.id === id)!)
  })

  app.delete('/api/v1/chat-agents/:id', (c) => {
    const id = c.req.param('id')
    if (!d.store.snapshot().customAgents.some((a) => a.id === id)) {
      return err(c, 404, 'not_found', 'Agent not found.')
    }
    d.store.update((cfg) => { cfg.customAgents = cfg.customAgents.filter((a) => a.id !== id) })
    return c.json({ ok: true })
  })
}
