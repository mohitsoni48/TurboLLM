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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function err(c: any, status: number, code: string, message: string) {
  return c.json({ error: { code, message } }, status)
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function body<T>(c: any): Promise<T> {
  try { return (await c.req.json()) as T } catch { return {} as T }
}

const AGENT_CAP = 50

function sanitizeStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
}

export function registerChatAgentRoutes(app: Hono, d: Deps): void {
  // Built-in overrides — registered before the /:id routes below (literal segments
  // take precedence, but this keeps the two resources visually separate too).
  app.get('/api/v1/chat-agents/builtin-overrides', (c) => c.json(d.store.snapshot().builtinAgentOverrides))

  app.put('/api/v1/chat-agents/builtin-overrides/:id', async (c) => {
    const id = c.req.param('id')
    if (!id.trim()) return err(c, 400, 'invalid_config_value', 'id is required.')
    const b = await body<BuiltinAgentOverride>(c)
    const override: BuiltinAgentOverride = {}
    if (b.name !== undefined) override.name = b.name.trim()
    if (b.description !== undefined) override.description = b.description.trim()
    if (b.systemPrompt !== undefined) override.systemPrompt = b.systemPrompt
    if (b.skillIds !== undefined) override.skillIds = sanitizeStringArray(b.skillIds)
    if (b.tools !== undefined) override.tools = sanitizeStringArray(b.tools)
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
    if (!d.store.snapshot().customAgents.some((a) => a.id === id)) {
      return err(c, 404, 'not_found', 'Agent not found.')
    }
    const b = await body<Partial<CustomChatAgent>>(c)
    if (b.name !== undefined && !b.name.trim()) return err(c, 400, 'invalid_config_value', 'name is required.')
    d.store.update((cfg) => {
      const a = cfg.customAgents.find((x) => x.id === id)!
      if (b.name !== undefined) a.name = b.name.trim()
      if (b.description !== undefined) a.description = b.description.trim()
      if (b.systemPrompt !== undefined) a.systemPrompt = b.systemPrompt
      if (b.skillIds !== undefined) a.skillIds = sanitizeStringArray(b.skillIds)
      if (b.tools !== undefined) a.tools = sanitizeStringArray(b.tools)
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
