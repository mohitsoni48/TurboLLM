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
import { ValueError, type AgentType } from '../config/config'
import { SkillStore, isBuiltinSkill, isValidSkillId, toSkillId, importSkillsFromFolder, type Skill } from './skills'
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
    if (d.store.snapshot().agents.agents.length >= 100) return err(c, 400, 'too_many_agents', 'Agent limit reached (100).')
    const dataDir = d.store.dir()
    const agent: AgentType = {
      id: randomUUID(),
      name: b.name.trim(),
      description: b.description?.trim() ?? '',
      systemPrompt: typeof b.systemPrompt === 'string' ? b.systemPrompt : '',
      skills: Array.isArray(b.skills) ? b.skills : [],
      readRoots: Array.isArray(b.readRoots) && b.readRoots.length ? b.readRoots : [dataDir],
      // Write root is FIXED to ~/.turbollm (spec 13 redesign §1.1) — never client-settable.
      writeRoots: [dataDir],
      callableAgents: Array.isArray(b.callableAgents) ? b.callableAgents : [],
      maxIterations: typeof b.maxIterations === 'number' ? b.maxIterations : 30,
    }
    try {
      d.store.update((cfg) => { cfg.agents.agents.push(agent) })
    } catch (e) {
      if (e instanceof ValueError) return err(c, 400, 'invalid_config_value', e.message)
      throw e
    }
    return c.json(agent, 201)
  })

  app.patch('/api/v1/agents/:id', async (c) => {
    if (!isLocalRequest(c, d)) return err(c, 403, 'forbidden', 'Agents can only be configured on the machine running TurboLLM.')
    const id = c.req.param('id')
    const b = await body<Partial<AgentType>>(c)
    const existing = d.store.snapshot().agents.agents.find((a) => a.id === id)
    if (!existing) return err(c, 404, 'not_found', 'Agent not found.')
    try {
      d.store.update((cfg) => {
        const a = cfg.agents.agents.find((x) => x.id === id)!
        // The builtin default's identity (name/id/builtin) is locked; its scope + skills are editable.
        if (!a.builtin && typeof b.name === 'string' && b.name.trim()) a.name = b.name.trim()
        if (typeof b.description === 'string') a.description = b.description.trim()
        if (typeof b.systemPrompt === 'string') a.systemPrompt = b.systemPrompt
        if (Array.isArray(b.skills)) a.skills = b.skills
        if (Array.isArray(b.readRoots)) a.readRoots = b.readRoots
        // writeRoots is FIXED to ~/.turbollm (spec 13 redesign §1.1) — never client-editable.
        a.writeRoots = [d.store.dir()]
        if (Array.isArray(b.callableAgents)) a.callableAgents = b.callableAgents
        if (typeof b.maxIterations === 'number') a.maxIterations = b.maxIterations
      })
    } catch (e) {
      if (e instanceof ValueError) return err(c, 400, 'invalid_config_value', e.message)
      throw e
    }
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
    d.db.pruneAgentLessons?.(id)
    d.db.pruneAgentSkills?.(id)
    return c.json({ ok: true })
  })

  // ── Grown skills (spec 13 redesign §3.3) ────────────────────────────────────
  const SKILL_CAP = 200

  // The shared skill library + this agent's lessons (for the management UI). Skills are
  // SKILL.md files shared across agents; lessons (Reflexion) remain per-agent.
  app.get('/api/v1/agents/:id/learned', (c) => {
    const id = c.req.param('id')
    return c.json({
      skills: skills().userSkills(),
      lessons: d.db.listAgentLessons?.(id) ?? [],
    })
  })

  app.delete('/api/v1/agents/:id/skills/:skillId', (c) => {
    if (!isLocalRequest(c, d)) return err(c, 403, 'forbidden', 'Local host only.')
    const skillId = c.req.param('skillId')
    if (isBuiltinSkill(skillId)) return err(c, 400, 'builtin_skill', 'Cannot delete a built-in skill.')
    skills().delete(skillId)
    return c.json({ ok: true })
  })

  // Learn a skill from a FOLDER (the "point it at a folder" feature). Local-gated (reads
  // disk). Detached distill → store. Returns immediately.
  app.post('/api/v1/agents/:id/learn-folder', async (c) => {
    if (!isLocalRequest(c, d)) return err(c, 403, 'forbidden', 'Local host only.')
    const id = c.req.param('id')
    if (!d.store.snapshot().agents.agents.some((a) => a.id === id)) return err(c, 404, 'not_found', 'Agent not found.')
    const b = await body<{ folder?: string }>(c)
    const folder = b.folder?.trim()
    if (!folder) return err(c, 400, 'invalid_input', 'folder is required.')
    const store = skills()
    if (store.userSkills().length >= SKILL_CAP) return err(c, 400, 'skill_cap', `Skill limit reached (${SKILL_CAP}).`)
    const taskId = d.agentTasks?.start('skill_from_folder', id, `Learning from ${folder}`)
    void (async () => {
      try {
        if (taskId) d.agentTasks?.step(taskId, 'Scanning the folder for skills…')
        const room = Math.max(0, SKILL_CAP - store.userSkills().length)
        // Primary path: the folder is a skill library (SKILL.md files) — import them
        // verbatim, preserving names. No LLM, no renaming.
        const { imported, skipped } = importSkillsFromFolder(store, folder, {
          max: room,
          onProgress: (sid) => { if (taskId) d.agentTasks?.step(taskId, `Imported ${sid}`) },
        })
        if (imported.length > 0 || skipped.length > 0) {
          if (taskId) {
            const parts = [`Imported ${imported.length} skill${imported.length === 1 ? '' : 's'}`]
            if (skipped.length) parts.push(`${skipped.length} already in library`)
            d.agentTasks?.done(taskId, imported.length ? `${parts.join(', ')}: ${imported.join(', ')}` : parts.join(', '))
          }
          return
        }
        // Fallback: no SKILL.md found — distill reusable skills from the folder's text files.
        if (taskId) d.agentTasks?.step(taskId, 'No skill files found — distilling from the folder…')
        const { distillSkillsFromFolder } = await import('./distiller')
        const distilled = await distillSkillsFromFolder(d, folder, {
          max: Math.max(0, SKILL_CAP - store.userSkills().length),
          onProgress: (done, total, file) => {
            if (taskId) d.agentTasks?.step(taskId, `Distilling ${done + 1}/${total}: ${file}`)
          },
        })
        const added: string[] = []
        for (const s of distilled) {
          if (store.userSkills().length >= SKILL_CAP) break
          if (!s.name || !s.procedure) continue
          const skillId = toSkillId(s.name)
          if (!skillId || store.has(skillId) || isBuiltinSkill(skillId)) continue
          store.write({ id: skillId, name: s.name, description: s.description ?? '', instructions: s.procedure, tools: [] })
          added.push(skillId)
        }
        if (taskId) {
          d.agentTasks?.done(
            taskId,
            added.length > 0
              ? `Saved ${added.length} skill${added.length === 1 ? '' : 's'}: ${added.join(', ')}`
              : 'No skills found in that folder.',
          )
        }
      } catch (e) {
        if (taskId) d.agentTasks?.fail(taskId, e instanceof Error ? e.message : 'learn failed')
      }
    })()
    return c.json({ ok: true, learning: true })
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
    // Cap the library (review M4): each list() reads+parses every file.
    const lib = skills().list()
    if (!lib.some((s) => s.id === b.id) && lib.length >= 200) return err(c, 400, 'too_many_skills', 'Skill limit reached (200).')
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
    // Deleting a skill removes a file on disk → local-gate + validate the id can't escape.
    if (!isLocalRequest(c, d)) return err(c, 403, 'forbidden', 'Skills can only be modified on the machine running TurboLLM.')
    const id = c.req.param('id')
    if (!isValidSkillId(id)) return err(c, 400, 'invalid_config_value', 'invalid skill id.')
    if (isBuiltinSkill(id)) return err(c, 400, 'builtin_skill', 'Built-in skills cannot be deleted.')
    skills().delete(id)
    return c.json({ ok: true })
  })

  // ── Runs ──────────────────────────────────────────────────────────────────
  const MAX_USER_MESSAGE = 100_000 // chars — guard against multi-MB prompts (review L2)
  app.post('/api/v1/agents/:id/runs', async (c) => {
    // A run EXECUTES host-side FS tools — gate it to the local host (review M1).
    if (!isLocalRequest(c, d)) return err(c, 403, 'forbidden', 'Agent runs can only be launched on the machine running TurboLLM.')
    if (!d.agents) return err(c, 501, 'not_implemented', 'Agent runner not available.')
    const agentId = c.req.param('id')
    const b = await body<{ title?: string; userMessage?: string }>(c)
    const msg = b.userMessage?.trim()
    if (!msg) return err(c, 400, 'invalid_input', 'userMessage is required.')
    if (msg.length > MAX_USER_MESSAGE) return err(c, 400, 'message_too_long', `userMessage exceeds ${MAX_USER_MESSAGE} characters.`)
    if (!d.store.snapshot().agents.agents.some((a) => a.id === agentId)) {
      return err(c, 404, 'not_found', 'Agent not found.')
    }
    try {
      const id = await d.agents.launch({
        agentId,
        title: b.title?.trim().slice(0, 200) || 'Agent run',
        userMessage: msg,
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
    const rawSeq = Number(c.req.query('fromSeq') ?? '0')
    const fromSeq = Number.isFinite(rawSeq) ? Math.max(0, Math.floor(rawSeq)) : 0 // ?fromSeq=abc → 0 (L1)
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

  // A run can be dispositioned only once, and only after it has finished. These guards
  // stop a tester from double-completing (duplicate track-record rows) or dispositioning
  // a still-running contract.
  const FINISHED = new Set(['done', 'failed', 'cancelled', 'interrupted'])
  const dispositionGuard = (runId: string): { run: import('../chat/db').AgentRun } | { error: [number, string, string] } => {
    const run = d.db.getAgentRun?.(runId)
    if (!run) return { error: [404, 'not_found', 'Run not found.'] }
    if (run.completion) return { error: [409, 'already_dispositioned', `This contract was already marked "${run.completion}".`] }
    if (!FINISHED.has(run.status)) return { error: [409, 'run_active', 'This contract is still running — cancel it first or wait for it to finish.'] }
    return { run }
  }

  // ✓ Mark complete → record 'complete' + archive.
  app.post('/api/v1/agents/runs/:id/complete', (c) => {
    if (!isLocalRequest(c, d)) return err(c, 403, 'forbidden', 'Local host only.')
    const id = c.req.param('id')
    const g = dispositionGuard(id)
    if ('error' in g) return err(c, g.error[0] as 404, g.error[1], g.error[2])
    recordOutcome(id, 'complete')
    d.db.setRunDisposition?.(id, 'complete', true)
    return c.json({ ok: true })
  })

  // ⛔ Flag miss → record 'miss' + feedback, then archive (v1 has no mid-run resume; the
  //    user starts a fresh contract to retry). The miss + feedback feed the track record.
  app.post('/api/v1/agents/runs/:id/flag-miss', async (c) => {
    if (!isLocalRequest(c, d)) return err(c, 403, 'forbidden', 'Local host only.')
    const id = c.req.param('id')
    const g = dispositionGuard(id)
    if ('error' in g) return err(c, g.error[0] as 404, g.error[1], g.error[2])
    const b = await body<{ feedback?: string }>(c)
    const feedback = b.feedback?.trim().slice(0, 5000) || undefined
    recordOutcome(id, 'miss', feedback)
    d.db.setRunDisposition?.(id, 'miss', true)
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
