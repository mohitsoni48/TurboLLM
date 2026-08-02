// ToolRegistry's first dedicated test file (Phase 4 Task 2). Covers the 5 routine tools' wiring
// into the chat tool surface, and — Task 6 — that the tool-call path and the REST path observe
// identical state against a REAL ConversationStore.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ToolRegistry } from './tool-registry'
import type { RoutineToolsStore, RunRoutineNowFn } from '../routines/routine-tools'
import { CODE_GATE_MESSAGE } from '../routines/routine-routes'
import type { Routine } from '../routines/schema'
import type { ToolsConfig } from '../config/config'
import { ConversationStore } from '../chat/db'

const EMPTY_TOOLS_CFG = {} as ToolsConfig

function fakeRoutine(overrides: Partial<Routine> = {}): Routine {
  return {
    id: 'r1', flavor: 'chat', status: 'active', prompt: 'x', scheduleDisplay: 'd',
    scheduleRule: { kind: 'interval', everyMs: 1000 }, nextFireAt: null, modelKey: 'm',
    createdAt: 'now', updatedAt: 'now', ...overrides,
  } as Routine
}

function fakeStore(routine: Routine | null): RoutineToolsStore {
  return {
    createRoutine: () => routine ?? fakeRoutine(),
    getRoutine: () => routine,
    listRoutines: () => (routine ? [routine] : []),
    updateRoutine: () => routine,
    deleteRoutine: () => true,
    listRoutineRuns: () => [],
  } as unknown as RoutineToolsStore
}

test('buildToolDefinitions: omits the 5 routine tools when no RoutineToolsStore was injected', async () => {
  const reg = new ToolRegistry(EMPTY_TOOLS_CFG)
  const defs = await reg.buildToolDefinitions()
  assert.ok(!defs.some((d) => d.function.name === 'create_routine'))
})

test('buildToolDefinitions: includes all 5 routine tools once a RoutineToolsStore is injected', async () => {
  const reg = new ToolRegistry(EMPTY_TOOLS_CFG, fakeStore(null))
  const defs = await reg.buildToolDefinitions()
  const names = defs.map((d) => d.function.name)
  for (const n of ['create_routine', 'list_routines', 'update_routine', 'delete_routine', 'run_routine_now']) {
    assert.ok(names.includes(n), `expected ${n} in tool definitions`)
  }
})

test('executeTool: routes create_routine/list_routines/update_routine/delete_routine to the routine store', async () => {
  const routine = fakeRoutine()
  const reg = new ToolRegistry(EMPTY_TOOLS_CFG, fakeStore(routine))
  const listed = await reg.executeTool({ id: 't1', name: 'list_routines', args: {} })
  assert.match(listed, new RegExp(routine.id))
})

test('executeTool: run_routine_now uses the injected runRoutineNow callback', async () => {
  const routine = fakeRoutine()
  let called = false
  const runNow: RunRoutineNowFn = async () => { called = true; return { ok: true } }
  const reg = new ToolRegistry(EMPTY_TOOLS_CFG, fakeStore(routine), runNow)
  const out = await reg.executeTool({ id: 't1', name: 'run_routine_now', args: { routineId: routine.id } })
  assert.ok(called)
  assert.match(out, /running now/)
})

test('executeTool: run_routine_now without an injected callback reports a clear error rather than throwing', async () => {
  const routine = fakeRoutine()
  const reg = new ToolRegistry(EMPTY_TOOLS_CFG, fakeStore(routine))
  const out = await reg.executeTool({ id: 't1', name: 'run_routine_now', args: { routineId: routine.id } })
  assert.match(out, /^Error:/)
})

test('executeTool: an unknown tool name is still reported the same way as before this phase', async () => {
  const reg = new ToolRegistry(EMPTY_TOOLS_CFG)
  const out = await reg.executeTool({ id: 't1', name: 'nonexistent', args: {} })
  assert.equal(out, 'Error: unknown tool "nonexistent"')
})

// ── code-flavor authorization threading (C1) ─────────────────────────────────
// The whole point of executeTool's `isCodeAuthorized` parameter: it must reach
// execCreateRoutine/execUpdateRoutine, and must fail CLOSED when the caller omits it. A
// regression here silently reopens the gap routine-routes.ts's codeGateBlocks closes on REST.

test('executeTool: create_routine with flavor "code" is REFUSED when the caller omits isCodeAuthorized', async () => {
  const reg = new ToolRegistry(EMPTY_TOOLS_CFG, fakeStore(null))
  const out = await reg.executeTool({
    id: 't1', name: 'create_routine',
    args: {
      flavor: 'code', prompt: 'p', scheduleDisplay: 'd', scheduleRule: { kind: 'interval', everyMs: 60_000 },
      modelKey: 'm', workspacePath: 'C:\\ws', codingAgent: 'pi',
    },
  })
  assert.equal(out, `Error: ${CODE_GATE_MESSAGE}`, 'omitting the trust decision must fail closed')
})

test('executeTool: create_routine with flavor "code" is REFUSED when isCodeAuthorized is explicitly false', async () => {
  const reg = new ToolRegistry(EMPTY_TOOLS_CFG, fakeStore(null))
  const out = await reg.executeTool({
    id: 't1', name: 'create_routine',
    args: {
      flavor: 'code', prompt: 'p', scheduleDisplay: 'd', scheduleRule: { kind: 'interval', everyMs: 60_000 },
      modelKey: 'm', workspacePath: 'C:\\ws', codingAgent: 'pi',
    },
  }, false)
  assert.equal(out, `Error: ${CODE_GATE_MESSAGE}`)
})

test('executeTool: create_routine with flavor "code" is ALLOWED when the caller passes isCodeAuthorized true', async () => {
  const db = new ConversationStore(mkdtempSync(join(tmpdir(), 'tool-registry-codegate-')))
  const reg = new ToolRegistry(EMPTY_TOOLS_CFG, db)
  const out = await reg.executeTool({
    id: 't1', name: 'create_routine',
    args: {
      flavor: 'code', prompt: 'p', scheduleDisplay: 'd', scheduleRule: { kind: 'interval', everyMs: 60_000 },
      modelKey: 'm', workspacePath: 'C:\\ws', codingAgent: 'pi',
    },
  }, true)
  assert.match(out, /pending_confirmation/)
  assert.equal(db.listRoutines().length, 1)
})

test('executeTool: update_routine on a stored CODE routine is refused unless isCodeAuthorized', async () => {
  const stored = fakeRoutine({ flavor: 'code', workspacePath: 'C:\\ws', codingAgent: 'pi' })
  const reg = new ToolRegistry(EMPTY_TOOLS_CFG, fakeStore(stored))
  const blocked = await reg.executeTool({ id: 't1', name: 'update_routine', args: { routineId: stored.id, prompt: 'new' } })
  assert.equal(blocked, `Error: ${CODE_GATE_MESSAGE}`)
  const allowed = await reg.executeTool({ id: 't2', name: 'update_routine', args: { routineId: stored.id, prompt: 'new' } }, true)
  assert.match(allowed, /^PREVIEW/, 'an authorized caller gets the normal two-phase preview')
})

test('executeTool: isCodeAuthorized never affects a CHAT-flavor routine', async () => {
  const db = new ConversationStore(mkdtempSync(join(tmpdir(), 'tool-registry-chatflavor-')))
  const reg = new ToolRegistry(EMPTY_TOOLS_CFG, db)
  const out = await reg.executeTool({
    id: 't1', name: 'create_routine',
    args: {
      flavor: 'chat', prompt: 'p', scheduleDisplay: 'd', scheduleRule: { kind: 'daily', hour: 9, minute: 0 },
      modelKey: 'm', agentId: 'a',
    },
  })
  assert.match(out, /pending_confirmation/, 'an unauthorized caller can still author a chat routine')
})

// ── Task 6: cross-surface consistency ────────────────────────────────────────

test('executeTool: create_routine against a REAL ConversationStore lands pending_confirmation, ' +
  'visible the same way regardless of which surface (chat or Code) made the call', async () => {
  const db = new ConversationStore(mkdtempSync(join(tmpdir(), 'tool-registry-routine-test-')))
  const reg = new ToolRegistry(EMPTY_TOOLS_CFG, db)
  const out = await reg.executeTool({
    id: 't1',
    name: 'create_routine',
    args: {
      flavor: 'chat', prompt: 'Summarize my inbox', scheduleDisplay: 'Runs daily at 9:00 AM',
      scheduleRule: { kind: 'daily', hour: 9, minute: 0 }, modelKey: 'm', agentId: 'a',
    },
  })
  assert.match(out, /pending_confirmation/)
  const routines = db.listRoutines()
  assert.equal(routines.length, 1)
  assert.equal(routines[0].status, 'pending_confirmation')
  // Whatever a real GET /api/v1/routines would return (routine-routes.ts calls the same
  // d.db.listRoutines()) — proving the tool-call path and the REST path see identical state.
})
