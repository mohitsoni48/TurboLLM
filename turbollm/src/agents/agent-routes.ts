// Agent + Skills HTTP routes (spec 13 §7, Phase 2 rebuild).
//
// Agent types (the persona-like definitions):
//   GET    /api/v1/agents              — list AgentType[]
//   POST   /api/v1/agents              — create subagent
//   PATCH  /api/v1/agents/:id          — edit (builtin's identity locked)
//   DELETE /api/v1/agents/:id          — delete subagent (404 on builtin)
// Skills (the global library):
//   GET    /api/v1/skills              — list Skill[]
//   POST   /api/v1/skills              — create/update a skill file
//   DELETE /api/v1/skills/:id          — delete (404 on builtin)
// Runs (agentic chat = a "contract"):
//   POST   /api/v1/agents/:id/runs     — start a run as agent :id
//   GET    /api/v1/agents/runs         — list runs (newest first)
//   GET    /api/v1/agents/runs/:id     — run + messages
//   DELETE /api/v1/agents/runs/:id     — cancel
//   GET    /api/v1/agents/runs/:id/stream — SSE replay + live-tail
import type { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { randomUUID } from 'node:crypto'
import type { Deps } from '../deps'
import type { AgentType } from '../config/config'
import { SkillStore, isBuiltinSkill, type Skill } from './skills'
import { isLocalRequest } from '../auth'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function err(c: any, status: number, code: string, message: string) {
  return c.json({ error: { code, message } }, status)
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function body<T>(c: any): Promise<T> {
  try { return (await c.req.json()) as T } catch { return {} as T }
}

export function registerAgentRoutes(app: Hono, d: Deps): void {
  const skills = () => new SkillStore(d.store.dir())

  // ── Agent types (CRUD) ────────────────────────────────────────────────────
  app.get('/api/v1/agents', (c) => c.json(d.store.snapshot().agents.agents))

  app.post('/api/v1/agents', async (c) => {
    // Configuring an agent grants host-disk read/write scope — gate to the local host.
    if (!isLocalRequest(c, d)) return err(c, 403, 'forbidden', 'Agents can only be configured on the machine running TurboLLM.')
    const b = await body<Partial<AgentType>>(c)
    if (!b.name?.trim()) return err(c, 400, 'invalid_config_value', 'name is required.')
    const dataDir = d.store.dir()
    const agent: AgentType = {
      id: randomUUID(),
      name: b.name.trim(),
      description: b.description?.trim() ?? '',
      skills: Array.isArray(b.skills) ? b.skills : [],
      readRoots: Array.isArray(b.readRoots) && b.readRoots.length ? b.readRoots : [dataDir],
      writeRoots: Array.isArray(b.writeRoots) && b.writeRoots.length ? b.writeRoots : [dataDir],
      callableAgents: Array.isArray(b.callableAgents) ? b.callableAgents : [],
      maxIterations: typeof b.maxIterations === 'number' ? b.maxIterations : 30,
    }
    d.store.update((cfg) => { cfg.agents.agents.push(agent) })
    return c.json(agent, 201)
  })

  app.patch('/api/v1/agents/:id', async (c) => {
    if (!isLocalRequest(c, d)) return err(c, 403, 'forbidden', 'Agents can only be configured on the machine running TurboLLM.')
    const id = c.req.param('id')
    const b = await body<Partial<AgentType>>(c)
    const existing = d.store.snapshot().agents.agents.find((a) => a.id === id)
    if (!existing) return err(c, 404, 'not_found', 'Agent not found.')
    d.store.update((cfg) => {
      const a = cfg.agents.agents.find((x) => x.id === id)!
      // The builtin default's identity (name/id/builtin) is locked; its scope + skills are editable.
      if (!a.builtin && typeof b.name === 'string' && b.name.trim()) a.name = b.name.trim()
      if (typeof b.description === 'string') a.description = b.description.trim()
      if (Array.isArray(b.skills)) a.skills = b.skills
      if (Array.isArray(b.readRoots)) a.readRoots = b.readRoots
      if (Array.isArray(b.writeRoots)) a.writeRoots = b.writeRoots
      if (Array.isArray(b.callableAgents)) a.callableAgents = b.callableAgents
      if (typeof b.maxIterations === 'number') a.maxIterations = b.maxIterations
    })
    return c.json(d.store.snapshot().agents.agents.find((a) => a.id === id))
  })

  app.delete('/api/v1/agents/:id', (c) => {
    const id = c.req.param('id')
    const a = d.store.snapshot().agents.agents.find((x) => x.id === id)
    if (!a) return err(c, 404, 'not_found', 'Agent not found.')
    if (a.builtin) return err(c, 400, 'builtin_agent', 'The default agent cannot be deleted.')
    d.store.update((cfg) => { cfg.agents.agents = cfg.agents.agents.filter((x) => x.id !== id) })
    // agent_id is a config id, not a DB FK — prune this Hitman's track-record rows (§13).
    d.db.pruneTrackRecordForAgent?.(id)
    return c.json({ ok: true })
  })

  // ── Skills (library) ──────────────────────────────────────────────────────
  app.get('/api/v1/skills', (c) => c.json(skills().list()))

  app.post('/api/v1/skills', async (c) => {
    if (!isLocalRequest(c, d)) return err(c, 403, 'forbidden', 'Skills can only be authored on the machine running TurboLLM.')
    const b = await body<Partial<Skill>>(c)
    if (!b.id?.trim() || !/^[a-z0-9-]+$/.test(b.id)) return err(c, 400, 'invalid_config_value', 'id must be kebab-case (a-z0-9-).')
    if (!b.name?.trim()) return err(c, 400, 'invalid_config_value', 'name is required.')
    if (isBuiltinSkill(b.id)) return err(c, 400, 'builtin_skill', 'Cannot overwrite a built-in skill.')
    if (!b.instructions?.trim()) return err(c, 400, 'invalid_config_value', 'instructions are required.')
    const skill: Skill = {
      id: b.id.trim(),
      name: b.name.trim(),
      description: b.description?.trim() ?? '',
      instructions: b.instructions,
      tools: Array.isArray(b.tools) ? b.tools : [],
    }
    skills().write(skill)
    return c.json(skill, 201)
  })

  app.delete('/api/v1/skills/:id', (c) => {
    const id = c.req.param('id')
    if (isBuiltinSkill(id)) return err(c, 400, 'builtin_skill', 'Built-in skills cannot be deleted.')
    skills().delete(id)
    return c.json({ ok: true })
  })

  // ── Runs ──────────────────────────────────────────────────────────────────
  app.post('/api/v1/agents/:id/runs', async (c) => {
    if (!d.agents) return err(c, 501, 'not_implemented', 'Agent runner not available.')
    const agentId = c.req.param('id')
    const b = await body<{ title?: string; userMessage?: string }>(c)
    if (!b.userMessage?.trim()) return err(c, 400, 'invalid_input', 'userMessage is required.')
    if (!d.store.snapshot().agents.agents.some((a) => a.id === agentId)) {
      return err(c, 404, 'not_found', 'Agent not found.')
    }
    try {
      const id = await d.agents.launch({
        agentId,
        title: b.title?.trim() || 'Agent run',
        userMessage: b.userMessage.trim(),
      })
      return c.json(d.db.getAgentRun?.(id), 201)
    } catch (e) {
      return err(c, 400, 'launch_failed', e instanceof Error ? e.message : String(e))
    }
  })

  app.get('/api/v1/agents/runs', (c) => {
    if (!d.db.listActiveAgentRuns) return err(c, 501, 'not_implemented', 'Agent runner not available.')
    // Active = non-archived contracts (§15); archived ones live under /agents/:id/archive.
    return c.json(d.db.listActiveAgentRuns())
  })

  app.get('/api/v1/agents/runs/:id', (c) => {
    const id = c.req.param('id')
    if (!d.db.getAgentRun) return err(c, 501, 'not_implemented', 'Agent runner not available.')
    const run = d.db.getAgentRun(id)
    if (!run) return err(c, 404, 'not_found', 'Run not found.')
    const conv = d.db.getConversation(run.convId, true)
    return c.json({ ...run, messages: conv?.messages ?? [] })
  })

  app.delete('/api/v1/agents/runs/:id', (c) => {
    const id = c.req.param('id')
    if (!d.agents) return err(c, 501, 'not_implemented', 'Agent runner not available.')
    const ok = d.agents.cancel(id)
    if (!ok) return err(c, 404, 'not_found', 'Run not found or already complete.')
    return c.json({ ok: true })
  })

  app.get('/api/v1/agents/runs/:id/stream', (c) => {
    const id = c.req.param('id')
    const fromSeq = Math.max(0, Number(c.req.query('fromSeq') ?? '0'))
    if (!d.agents) return err(c, 501, 'not_implemented', 'Agent runner not available.')
    const run = d.db.getAgentRun?.(id)
    if (!run) return err(c, 404, 'not_found', 'Run not found.')

    return streamSSE(c, async (stream) => {
      const sub = d.agents!.subscribe(id, fromSeq)
      stream.onAbort(() => sub.close())
      try {
        for await (const ev of sub) {
          await stream.writeSSE({ event: ev.event, data: JSON.stringify(ev.data) })
          if (ev.event === 'done' || ev.event === 'error') break
        }
      } finally {
        sub.close()
      }
    })
  })

  // ── Hitman layer (spec 13 §§12-15) ──────────────────────────────────────────

  // The durable working doc for a run.
  app.get('/api/v1/agents/runs/:id/doc', (c) => {
    if (!d.db.getRunDoc) return err(c, 501, 'not_implemented', 'Not available.')
    const run = d.db.getAgentRun?.(c.req.param('id'))
    if (!run) return err(c, 404, 'not_found', 'Run not found.')
    return c.json({ content: d.db.getRunDoc(run.id) })
  })

  // Helper: write a track-record row for a finished contract (the model that ran it
  // lives on the run's conversation modelKey, set by the run manager).
  const recordOutcome = (runId: string, outcome: 'complete' | 'miss', feedback?: string) => {
    const run = d.db.getAgentRun?.(runId)
    if (!run?.agentId) return
    const conv = d.db.getConversation(run.convId)
    const model = conv?.modelKey || 'unknown'
    d.db.addTrackRecord?.({ agentId: run.agentId, runId, model, outcome, feedback })
  }

  // ✓ Mark complete → record 'complete' + archive.
  app.post('/api/v1/agents/runs/:id/complete', (c) => {
    const id = c.req.param('id')
    const run = d.db.getAgentRun?.(id)
    if (!run) return err(c, 404, 'not_found', 'Run not found.')
    recordOutcome(id, 'complete')
    d.db.setRunDisposition?.(id, 'complete', true)
    return c.json({ ok: true })
  })

  // ⛔ Flag miss → record 'miss' + feedback. Run stays available for the user to Reply.
  app.post('/api/v1/agents/runs/:id/flag-miss', async (c) => {
    const id = c.req.param('id')
    const run = d.db.getAgentRun?.(id)
    if (!run) return err(c, 404, 'not_found', 'Run not found.')
    const b = await body<{ feedback?: string }>(c)
    recordOutcome(id, 'miss', b.feedback?.trim() || undefined)
    d.db.setRunDisposition?.(id, 'miss', false)
    return c.json({ ok: true })
  })

  // Per-Hitman track record (rows + per-model stats) — drives the warn/suggest UI.
  app.get('/api/v1/agents/:id/track-record', (c) => {
    if (!d.db.trackRecordForAgent) return err(c, 501, 'not_implemented', 'Not available.')
    const agentId = c.req.param('id')
    return c.json({
      rows: d.db.trackRecordForAgent(agentId),
      modelStats: d.db.modelStatsForAgent?.(agentId) ?? [],
    })
  })

  // Archived contracts for a Hitman.
  app.get('/api/v1/agents/:id/archive', (c) => {
    if (!d.db.listArchivedAgentRuns) return err(c, 501, 'not_implemented', 'Not available.')
    return c.json(d.db.listArchivedAgentRuns(c.req.param('id')))
  })
}
