import type { Hono } from 'hono'
import type { Context } from 'hono'
import type { Deps } from '../deps'
import { computeNextFireTime } from './schedule'
import type { ScheduleRule, RoutineFlavor } from './schema'

type Status = 200 | 201 | 400 | 404 | 409

function err(c: Context, status: Status, code: string, message: string) {
  return c.json({ error: { code, message } }, status)
}

async function body<T>(c: Context): Promise<T> {
  try { return (await c.req.json()) as T } catch { return {} as T }
}

interface RoutineBody {
  flavor?: RoutineFlavor
  prompt?: string
  scheduleDisplay?: string
  scheduleRule?: ScheduleRule
  modelKey?: string
  agentId?: string
  workspacePath?: string
  codingAgent?: 'pi' | 'claude_cli'
  permissionMode?: 'auto' | 'plan' | 'ask'
}

function validateCreate(b: RoutineBody): string | null {
  if (b.flavor !== 'chat' && b.flavor !== 'code') return 'flavor must be "chat" or "code".'
  if (!b.prompt?.trim()) return 'prompt is required.'
  if (!b.scheduleDisplay?.trim()) return 'scheduleDisplay is required.'
  if (!b.scheduleRule) return 'scheduleRule is required.'
  if (!b.modelKey?.trim()) return 'modelKey is required.'
  if (b.flavor === 'chat' && !b.agentId?.trim()) return 'agentId is required for a chat-flavor routine.'
  if (b.flavor === 'code' && !b.workspacePath?.trim()) return 'workspacePath is required for a code-flavor routine.'
  if (b.flavor === 'code' && b.codingAgent !== 'pi' && b.codingAgent !== 'claude_cli') return 'codingAgent must be "pi" or "claude_cli" for a code-flavor routine.'
  return null
}

export function registerRoutineRoutes(app: Hono, d: Deps): void {
  app.get('/api/v1/routines', (c) => c.json(d.db.listRoutines()))

  app.get('/api/v1/routines/:id', (c) => {
    const routine = d.db.getRoutine(c.req.param('id'))
    if (!routine) return err(c, 404, 'not_found', 'Routine not found.')
    return c.json(routine)
  })

  app.get('/api/v1/routines/:id/runs', (c) => {
    const routine = d.db.getRoutine(c.req.param('id'))
    if (!routine) return err(c, 404, 'not_found', 'Routine not found.')
    return c.json(d.db.listRoutineRuns(routine.id))
  })

  app.post('/api/v1/routines', async (c) => {
    const b = await body<RoutineBody>(c)
    const problem = validateCreate(b)
    if (problem) return err(c, 400, 'invalid_routine', problem)
    const routine = d.db.createRoutine({
      flavor: b.flavor!, prompt: b.prompt!.trim(), scheduleDisplay: b.scheduleDisplay!.trim(),
      scheduleRule: b.scheduleRule!, modelKey: b.modelKey!.trim(), agentId: b.agentId,
      workspacePath: b.workspacePath, codingAgent: b.codingAgent, permissionMode: b.permissionMode,
    })
    return c.json(routine, 201)
  })

  app.put('/api/v1/routines/:id/confirm', (c) => {
    const routine = d.db.getRoutine(c.req.param('id'))
    if (!routine) return err(c, 404, 'not_found', 'Routine not found.')
    if (routine.status !== 'pending_confirmation') return err(c, 409, 'not_pending', 'Routine is not awaiting confirmation.')
    const nextFireAt = computeNextFireTime(routine.scheduleRule, new Date()).toISOString()
    return c.json(d.db.confirmRoutine(routine.id, nextFireAt))
  })

  app.put('/api/v1/routines/:id', async (c) => {
    const routine = d.db.getRoutine(c.req.param('id'))
    if (!routine) return err(c, 404, 'not_found', 'Routine not found.')
    const b = await body<Partial<RoutineBody>>(c)
    if (b.prompt !== undefined && !b.prompt.trim()) return err(c, 400, 'invalid_routine', 'prompt cannot be empty.')
    const patch: Parameters<typeof d.db.updateRoutine>[1] = {}
    if (b.prompt !== undefined) patch.prompt = b.prompt.trim()
    if (b.scheduleDisplay !== undefined) patch.scheduleDisplay = b.scheduleDisplay.trim()
    if (b.scheduleRule !== undefined) {
      patch.scheduleRule = b.scheduleRule
      if (routine.status === 'active') patch.nextFireAt = computeNextFireTime(b.scheduleRule, new Date()).toISOString()
    }
    if (b.modelKey !== undefined) patch.modelKey = b.modelKey.trim()
    if (b.workspacePath !== undefined) patch.workspacePath = b.workspacePath
    if (b.codingAgent !== undefined) patch.codingAgent = b.codingAgent
    if (b.permissionMode !== undefined) patch.permissionMode = b.permissionMode
    return c.json(d.db.updateRoutine(routine.id, patch))
  })

  app.put('/api/v1/routines/:id/pause', (c) => {
    const routine = d.db.getRoutine(c.req.param('id'))
    if (!routine) return err(c, 404, 'not_found', 'Routine not found.')
    // Guarding on 'active' is what keeps /confirm the ONLY door into 'active': without it,
    // pending_confirmation -> pause -> resume walks a never-confirmed routine straight to
    // active, since /resume only checks for 'paused'.
    if (routine.status !== 'active') return err(c, 409, 'not_active', 'Routine is not active.')
    return c.json(d.db.updateRoutine(routine.id, { status: 'paused', nextFireAt: null }))
  })

  app.put('/api/v1/routines/:id/resume', (c) => {
    const routine = d.db.getRoutine(c.req.param('id'))
    if (!routine) return err(c, 404, 'not_found', 'Routine not found.')
    if (routine.status !== 'paused') return err(c, 409, 'not_paused', 'Routine is not paused.')
    const nextFireAt = computeNextFireTime(routine.scheduleRule, new Date()).toISOString()
    return c.json(d.db.updateRoutine(routine.id, { status: 'active', nextFireAt }))
  })

  app.delete('/api/v1/routines/:id', (c) => {
    if (!d.db.deleteRoutine(c.req.param('id'))) return err(c, 404, 'not_found', 'Routine not found.')
    return c.json({ ok: true })
  })
}
