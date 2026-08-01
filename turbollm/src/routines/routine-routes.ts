import type { Hono } from 'hono'
import type { Context } from 'hono'
import type { Deps } from '../deps'
import { isLocalRequest, verifyPresentedKey } from '../auth'
import { computeNextFireTime } from './schedule'
import type { ScheduleRule, RoutineFlavor, Routine } from './schema'

type Status = 200 | 201 | 400 | 401 | 404 | 409

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

function isInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v)
}

/** Structural validation of the client-supplied `scheduleRule` JSON. Nothing downstream
 *  (`computeNextFireTime`, the scheduler tick loop) re-checks these, so this is the only
 *  layer standing between request JSON and the schedule math: an unrecognised `kind`
 *  reaches `new Date(NaN).toISOString()` and throws a `RangeError` out of the handler
 *  (a 500, which breaks the error-envelope convention), and `everyMs <= 0` yields a
 *  routine whose `next_fire_at` is permanently in the past — it fires on every tick,
 *  forever. Exported so both POST and PUT go through the identical check. */
export function validateScheduleRule(rule: unknown): string | null {
  if (!rule || typeof rule !== 'object' || Array.isArray(rule)) return 'scheduleRule must be an object.'
  const r = rule as { kind?: unknown; everyMs?: unknown; hour?: unknown; minute?: unknown; daysOfWeek?: unknown }
  if (r.kind !== 'interval' && r.kind !== 'daily' && r.kind !== 'weekly') {
    return 'scheduleRule.kind must be "interval", "daily" or "weekly".'
  }
  if (r.kind === 'interval') {
    if (typeof r.everyMs !== 'number' || !Number.isFinite(r.everyMs) || r.everyMs <= 0) {
      return 'scheduleRule.everyMs must be a positive number of milliseconds.'
    }
    return null
  }
  if (!isInt(r.hour) || r.hour < 0 || r.hour > 23) return 'scheduleRule.hour must be an integer between 0 and 23.'
  if (!isInt(r.minute) || r.minute < 0 || r.minute > 59) return 'scheduleRule.minute must be an integer between 0 and 59.'
  if (r.kind === 'weekly') {
    if (!Array.isArray(r.daysOfWeek) || r.daysOfWeek.length === 0) {
      return 'scheduleRule.daysOfWeek must be a non-empty array of weekday numbers.'
    }
    if (!r.daysOfWeek.every((day) => isInt(day) && day >= 0 && day <= 6)) {
      return 'scheduleRule.daysOfWeek entries must be integers between 0 (Sunday) and 6 (Saturday).'
    }
  }
  return null
}

/** The field checks that apply identically on create and update. Neither `permission_mode`
 *  nor `coding_agent` has a column-level CHECK constraint (unlike `flavor`/`status`), so
 *  this is the only thing keeping junk out of two fields Phase 2 will branch on. */
function validateCommonFields(b: RoutineBody): string | null {
  if (b.permissionMode !== undefined && b.permissionMode !== 'auto' && b.permissionMode !== 'plan' && b.permissionMode !== 'ask') {
    return 'permissionMode must be "auto", "plan" or "ask".'
  }
  if (b.codingAgent !== undefined && b.codingAgent !== 'pi' && b.codingAgent !== 'claude_cli') {
    return 'codingAgent must be "pi" or "claude_cli".'
  }
  if (b.scheduleRule !== undefined) return validateScheduleRule(b.scheduleRule)
  return null
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
  return validateCommonFields(b)
}

/** Update-time counterpart of {@link validateCreate}. Only fields actually present in the
 *  PUT body are checked; flavor-dependent invariants are re-checked against the routine's
 *  CURRENT flavor (which PUT cannot change) rather than the request body alone. */
function validateUpdate(b: RoutineBody, current: Routine): string | null {
  if (b.prompt !== undefined && !b.prompt.trim()) return 'prompt cannot be empty.'
  if (current.flavor === 'code' && b.workspacePath !== undefined && !b.workspacePath.trim()) {
    return 'workspacePath cannot be empty for a code-flavor routine.'
  }
  return validateCommonFields(b)
}

/** codeAuth's decision (auth.ts), applied inline instead of as middleware. `/api/v1/code/*`
 *  is mounted behind `codeAuth` because it runs real bash/edit/write against the user's
 *  filesystem; a `flavor: 'code'` routine schedules exactly that capability, unattended and
 *  on a timer, so creating or editing one has to clear the same bar. It cannot be a mounted
 *  middleware here: `/api/v1/routines*` also serves chat routines, which stay on the
 *  baseline lanAuth gate — only the code-flavor requests are gated, hence a handler-level
 *  branch over the identical `isLocalRequest || verifyPresentedKey` check (the same shape
 *  terminal-routes.ts uses for its raw WebSocket upgrade, for the same reason). */
function codeGateBlocks(c: Context, d: Deps): boolean {
  return !isLocalRequest(c, d) && !verifyPresentedKey(c, d)
}

const CODE_GATE_MESSAGE = 'A valid API key is required to schedule a Code routine from a non-host device.'

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
    // Auth before validation, so an ungated caller learns nothing about the request shape.
    if (b.flavor === 'code' && codeGateBlocks(c, d)) return err(c, 401, 'unauthorized', CODE_GATE_MESSAGE)
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
    const b = await body<RoutineBody>(c)
    // PUT cannot change `flavor` today, so the stored one decides; `b.flavor` is checked too
    // so this stays correct if a later phase ever makes the field mutable.
    if ((routine.flavor === 'code' || b.flavor === 'code') && codeGateBlocks(c, d)) {
      return err(c, 401, 'unauthorized', CODE_GATE_MESSAGE)
    }
    const problem = validateUpdate(b, routine)
    if (problem) return err(c, 400, 'invalid_routine', problem)
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
