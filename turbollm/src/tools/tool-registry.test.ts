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
import { CODE_GATE_MESSAGE, ROUTINES_DISABLED_MESSAGE } from '../routines/routine-routes'
import type { Routine } from '../routines/schema'
import type { ToolsConfig, CustomChatAgent } from '../config/config'
import { ConversationStore } from '../chat/db'
import type { AgentToolsStore } from '../chat/chat-agent-tools'
import type { ModelToolsStore } from '../models/model-tools'

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

// Routines is experimental, off by default (daemon.experimental.routines, config.ts) — the 6th
// constructor param is a LIVE getter (cli.ts passes `() => store.snapshot().daemon.experimental.
// routines`) so Settings → Experimental can flip it without a restart. Every other test in this
// file omits the param entirely and must keep behaving exactly as before (default: enabled).
test('buildToolDefinitions: omits only create_routine when the experimental flag getter reports false', async () => {
  const reg = new ToolRegistry(EMPTY_TOOLS_CFG, fakeStore(null), undefined, undefined, undefined, () => false)
  const defs = await reg.buildToolDefinitions()
  const names = defs.map((d) => d.function.name)
  assert.ok(!names.includes('create_routine'), 'create_routine must not be advertised while disabled')
  for (const n of ['list_routines', 'update_routine', 'delete_routine', 'run_routine_now']) {
    assert.ok(names.includes(n), `${n} should stay available — only creation is gated`)
  }
})

test('executeTool: create_routine refuses with a clear error while the experimental flag getter reports false', async () => {
  const reg = new ToolRegistry(EMPTY_TOOLS_CFG, fakeStore(null), undefined, undefined, undefined, () => false)
  const out = await reg.executeTool({
    id: 't1', name: 'create_routine',
    args: { flavor: 'chat', prompt: 'x', scheduleDisplay: 'd', scheduleRule: { kind: 'interval', everyMs: 1000 }, modelKey: 'm', agentId: 'a' },
  })
  assert.equal(out, `Error: ${ROUTINES_DISABLED_MESSAGE}`)
})

test('executeTool: create_routine succeeds when the experimental flag getter reports true', async () => {
  const reg = new ToolRegistry(EMPTY_TOOLS_CFG, fakeStore(null), undefined, undefined, undefined, () => true)
  const out = await reg.executeTool({
    id: 't1', name: 'create_routine',
    args: { flavor: 'chat', prompt: 'x', scheduleDisplay: 'd', scheduleRule: { kind: 'interval', everyMs: 1000 }, modelKey: 'm', agentId: 'a' },
  })
  assert.match(out, /^Created routine/)
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
// execCreateRoutine/execUpdateRoutine/execRunRoutineNow, and must fail CLOSED when the caller
// omits it. A regression here silently reopens the gap routine-routes.ts's codeGateBlocks
// closes on REST.

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

// run_routine_now is the sharpest of the three gated tools: it reaches real unattended
// bash/edit/write on the host IMMEDIATELY, with no pending_confirmation step in between, on any
// routine a human ever confirmed (paused included). REST refuses it with 401 for an unauthorized
// caller (routine-routes.ts's /run-now handler); the tool surface must refuse it identically, or a
// keyless LAN caller can list_routines to find a code routine's id and fire it through chat.

test('executeTool: run_routine_now on a CODE routine is REFUSED when the caller omits isCodeAuthorized', async () => {
  const stored = fakeRoutine({ flavor: 'code', status: 'active', workspacePath: 'C:\\ws', codingAgent: 'pi' })
  const runNow: RunRoutineNowFn = async () => { assert.fail('the scheduler must never be reached by an unauthorized caller') }
  const reg = new ToolRegistry(EMPTY_TOOLS_CFG, fakeStore(stored), runNow)
  const out = await reg.executeTool({ id: 't1', name: 'run_routine_now', args: { routineId: stored.id } })
  assert.equal(out, `Error: ${CODE_GATE_MESSAGE}`, 'omitting the trust decision must fail closed')
})

test('executeTool: run_routine_now on a CODE routine is REFUSED when isCodeAuthorized is explicitly false', async () => {
  const stored = fakeRoutine({ flavor: 'code', status: 'active', workspacePath: 'C:\\ws', codingAgent: 'pi' })
  const runNow: RunRoutineNowFn = async () => { assert.fail('the scheduler must never be reached by an unauthorized caller') }
  const reg = new ToolRegistry(EMPTY_TOOLS_CFG, fakeStore(stored), runNow)
  const out = await reg.executeTool({ id: 't1', name: 'run_routine_now', args: { routineId: stored.id } }, false)
  assert.equal(out, `Error: ${CODE_GATE_MESSAGE}`)
})

test('executeTool: run_routine_now on a PAUSED CODE routine is refused too — the reviewer\'s exact traced target', async () => {
  const stored = fakeRoutine({ flavor: 'code', status: 'paused', workspacePath: 'C:\\ws', codingAgent: 'pi' })
  const runNow: RunRoutineNowFn = async () => { assert.fail('a paused code routine must not be firable by an unauthorized caller either') }
  const reg = new ToolRegistry(EMPTY_TOOLS_CFG, fakeStore(stored), runNow)
  assert.equal(await reg.executeTool({ id: 't1', name: 'run_routine_now', args: { routineId: stored.id } }), `Error: ${CODE_GATE_MESSAGE}`)
})

test('executeTool: run_routine_now on a CODE routine is ALLOWED (real scheduler call) when isCodeAuthorized is true', async () => {
  const stored = fakeRoutine({ flavor: 'code', status: 'active', workspacePath: 'C:\\ws', codingAgent: 'pi' })
  let calledWith: string | null = null
  const runNow: RunRoutineNowFn = async (id) => { calledWith = id; return { ok: true } }
  const reg = new ToolRegistry(EMPTY_TOOLS_CFG, fakeStore(stored), runNow)
  const out = await reg.executeTool({ id: 't1', name: 'run_routine_now', args: { routineId: stored.id } }, true)
  assert.equal(calledWith, stored.id, 'an authorized caller reaches the real injected scheduler')
  assert.match(out, /running now/)
})

test('executeTool: run_routine_now on a CHAT-flavor routine is unaffected by isCodeAuthorized', async () => {
  const stored = fakeRoutine({ flavor: 'chat', status: 'active' })
  for (const gate of [undefined, false, true] as const) {
    let called = false
    const runNow: RunRoutineNowFn = async () => { called = true; return { ok: true } }
    const reg = new ToolRegistry(EMPTY_TOOLS_CFG, fakeStore(stored), runNow)
    const out = await reg.executeTool({ id: 't1', name: 'run_routine_now', args: { routineId: stored.id } }, gate)
    assert.equal(called, true, `chat flavor must run with isCodeAuthorized=${String(gate)}`)
    assert.match(out, /running now/)
  }
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

// ── agent tools (list_agents/create_agent) ───────────────────────────────────
// Closes the gap where a chat-flavor create_routine needed an agentId the model had no way to
// discover or create on its own (see chat-agent-tools.ts's module header).

function fakeAgentStore(initial: CustomChatAgent[] = []): AgentToolsStore {
  let customAgents = initial
  return {
    snapshot: () => ({ customAgents }),
    update: (fn) => {
      const cfg = { customAgents: [...customAgents] }
      fn(cfg)
      customAgents = cfg.customAgents
    },
  }
}

test('buildToolDefinitions: omits list_agents/create_agent when no AgentToolsStore was injected', async () => {
  const reg = new ToolRegistry(EMPTY_TOOLS_CFG)
  const defs = await reg.buildToolDefinitions()
  assert.ok(!defs.some((d) => d.function.name === 'list_agents'))
  assert.ok(!defs.some((d) => d.function.name === 'create_agent'))
})

test('buildToolDefinitions: includes list_agents/create_agent once an AgentToolsStore is injected', async () => {
  const reg = new ToolRegistry(EMPTY_TOOLS_CFG, undefined, undefined, fakeAgentStore())
  const defs = await reg.buildToolDefinitions()
  const names = defs.map((d) => d.function.name)
  assert.ok(names.includes('list_agents'))
  assert.ok(names.includes('create_agent'))
})

test('executeTool: list_agents/create_agent route to the injected agent store, unaffected by isCodeAuthorized', async () => {
  const reg = new ToolRegistry(EMPTY_TOOLS_CFG, undefined, undefined, fakeAgentStore())
  const empty = await reg.executeTool({ id: 't1', name: 'list_agents', args: {} })
  assert.match(empty, /No custom agents/)

  const created = await reg.executeTool({ id: 't2', name: 'create_agent', args: { name: 'Job Search Assistant' } })
  assert.match(created, /^Created agent/)

  const listed = await reg.executeTool({ id: 't3', name: 'list_agents', args: {} })
  assert.match(listed, /Job Search Assistant/)
})

test('executeTool: create_routine can consume the agentId create_agent just returned, in one flow', async () => {
  const db = new ConversationStore(mkdtempSync(join(tmpdir(), 'tool-registry-agentflow-')))
  const reg = new ToolRegistry(EMPTY_TOOLS_CFG, db, undefined, fakeAgentStore())

  const created = await reg.executeTool({ id: 't1', name: 'create_agent', args: { name: 'Job Search Assistant', tools: ['web_search'] } })
  const agentId = created.match(/^Created agent (\S+)/)?.[1]
  assert.ok(agentId, `expected an id in: ${created}`)

  const routineOut = await reg.executeTool({
    id: 't2', name: 'create_routine',
    args: {
      flavor: 'chat', prompt: 'Find Android jobs', scheduleDisplay: 'Runs every hour',
      scheduleRule: { kind: 'interval', everyMs: 3_600_000 }, modelKey: 'm', agentId,
    },
  })
  assert.match(routineOut, /pending_confirmation/)
})

// ── model tool (list_models) ──────────────────────────────────────────────────
// Closes the gap where create_routine's modelKey needed a real compound id the model had no way
// to discover — observed live, a caller with no list_models guessed "gpt-4" instead.

function fakeModelStore(models: Array<{ key: string; name: string; quant: string; sizeLabel: string }> = []): ModelToolsStore {
  return { list: () => ({ models }) }
}

test('buildToolDefinitions: omits list_models when no ModelToolsStore was injected', async () => {
  const reg = new ToolRegistry(EMPTY_TOOLS_CFG)
  const defs = await reg.buildToolDefinitions()
  assert.ok(!defs.some((d) => d.function.name === 'list_models'))
})

test('buildToolDefinitions: includes list_models once a ModelToolsStore is injected', async () => {
  const reg = new ToolRegistry(EMPTY_TOOLS_CFG, undefined, undefined, undefined, fakeModelStore())
  const defs = await reg.buildToolDefinitions()
  assert.ok(defs.some((d) => d.function.name === 'list_models'))
})

test('executeTool: list_models routes to the injected model store and returns the real compound key', async () => {
  const reg = new ToolRegistry(EMPTY_TOOLS_CFG, undefined, undefined, undefined, fakeModelStore([
    { key: 'gemma 4 26b a4b qat|Q4_0|14439362752', name: 'Gemma 4 26B A4B QAT', quant: 'Q4_0', sizeLabel: '26B-A4B' },
  ]))
  const out = await reg.executeTool({ id: 't1', name: 'list_models', args: {} })
  assert.match(out, /gemma 4 26b a4b qat\|Q4_0\|14439362752/)
})
