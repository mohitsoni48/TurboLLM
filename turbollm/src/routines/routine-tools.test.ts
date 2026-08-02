import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConversationStore } from '../chat/db'
import {
  execCreateRoutine, execListRoutines, execUpdateRoutine, execDeleteRoutine, execRunRoutineNow,
  CREATE_ROUTINE_TOOL, LIST_ROUTINES_TOOL, UPDATE_ROUTINE_TOOL, DELETE_ROUTINE_TOOL, RUN_ROUTINE_NOW_TOOL,
} from './routine-tools'

function freshStore(): ConversationStore {
  return new ConversationStore(mkdtempSync(join(tmpdir(), 'routine-tools-test-')))
}

function chatRoutine(store: ConversationStore, prompt = 'x') {
  return store.createRoutine({
    flavor: 'chat', prompt, scheduleDisplay: 'd', scheduleRule: { kind: 'interval', everyMs: 1000 },
    modelKey: 'm', agentId: 'a',
  })
}

/** A runNow that fails the test if it is ever called — used to prove the preview/guard paths
 *  never reach the injected side effect. */
const neverCalled = async (): Promise<{ ok: true }> => {
  assert.fail('runNow must not be called on this path')
}

// ── create_routine ────────────────────────────────────────────────────────

test('execCreateRoutine: valid chat-flavor input creates a pending_confirmation routine', async () => {
  const store = freshStore()
  const msg = await execCreateRoutine({
    flavor: 'chat', prompt: 'Summarize my inbox', scheduleDisplay: 'Runs daily at 9:00 AM',
    scheduleRule: { kind: 'daily', hour: 9, minute: 0 }, modelKey: 'qwen3-coder-32b', agentId: 'agent-1',
  }, store)
  assert.match(msg, /pending_confirmation/)
  const routines = store.listRoutines()
  assert.equal(routines.length, 1)
  assert.equal(routines[0].status, 'pending_confirmation')
  assert.equal(routines[0].nextFireAt, null)
})

test('execCreateRoutine: a valid code-flavor routine persists workspacePath/codingAgent/permissionMode', async () => {
  const store = freshStore()
  const msg = await execCreateRoutine({
    flavor: 'code', prompt: 'Run the tests', scheduleDisplay: 'Runs hourly',
    scheduleRule: { kind: 'interval', everyMs: 3_600_000 }, modelKey: 'm',
    workspacePath: 'D:\\repo', codingAgent: 'pi', permissionMode: 'plan',
  }, store)
  assert.match(msg, /pending_confirmation/)
  const [r] = store.listRoutines()
  assert.equal(r.flavor, 'code')
  assert.equal(r.workspacePath, 'D:\\repo')
  assert.equal(r.codingAgent, 'pi')
  assert.equal(r.permissionMode, 'plan')
  assert.equal(r.status, 'pending_confirmation')
})

test('execCreateRoutine: code flavor missing workspacePath is rejected and nothing is created', async () => {
  const store = freshStore()
  const msg = await execCreateRoutine({
    flavor: 'code', prompt: 'x', scheduleDisplay: 'd', scheduleRule: { kind: 'interval', everyMs: 1000 },
    modelKey: 'm', codingAgent: 'pi',
  }, store)
  assert.match(msg, /^Error:/)
  assert.match(msg, /workspacePath/)
  assert.equal(store.listRoutines().length, 0)
})

test('execCreateRoutine: chat flavor missing agentId is rejected and nothing is created', async () => {
  const store = freshStore()
  const msg = await execCreateRoutine({
    flavor: 'chat', prompt: 'x', scheduleDisplay: 'd', scheduleRule: { kind: 'interval', everyMs: 1000 }, modelKey: 'm',
  }, store)
  assert.match(msg, /^Error:/)
  assert.match(msg, /agentId/)
  assert.equal(store.listRoutines().length, 0)
})

test('execCreateRoutine: an unrecognized scheduleRule.kind is rejected and nothing is created', async () => {
  const store = freshStore()
  const msg = await execCreateRoutine({
    flavor: 'chat', prompt: 'x', scheduleDisplay: 'd', scheduleRule: { kind: 'fortnightly' },
    modelKey: 'm', agentId: 'a',
  }, store)
  assert.match(msg, /^Error:/)
  assert.match(msg, /scheduleRule\.kind/)
  assert.equal(store.listRoutines().length, 0)
})

test('execCreateRoutine: a daily scheduleRule missing hour/minute is rejected', async () => {
  const store = freshStore()
  const msg = await execCreateRoutine({
    flavor: 'chat', prompt: 'x', scheduleDisplay: 'd', scheduleRule: { kind: 'daily' },
    modelKey: 'm', agentId: 'a',
  }, store)
  assert.match(msg, /^Error:/)
  assert.match(msg, /scheduleRule\.hour/)
  assert.equal(store.listRoutines().length, 0)
})

test('execCreateRoutine: a non-positive interval everyMs is rejected (would fire forever)', async () => {
  const store = freshStore()
  const msg = await execCreateRoutine({
    flavor: 'chat', prompt: 'x', scheduleDisplay: 'd', scheduleRule: { kind: 'interval', everyMs: 0 },
    modelKey: 'm', agentId: 'a',
  }, store)
  assert.match(msg, /^Error:/)
  assert.match(msg, /everyMs/)
  assert.equal(store.listRoutines().length, 0)
})

test('execCreateRoutine: a weekly rule with an out-of-range weekday is rejected', async () => {
  const store = freshStore()
  const msg = await execCreateRoutine({
    flavor: 'chat', prompt: 'x', scheduleDisplay: 'd',
    scheduleRule: { kind: 'weekly', hour: 9, minute: 0, daysOfWeek: [1, 7] },
    modelKey: 'm', agentId: 'a',
  }, store)
  assert.match(msg, /^Error:/)
  assert.match(msg, /daysOfWeek/)
  assert.equal(store.listRoutines().length, 0)
})

test('execCreateRoutine: a non-string prompt returns an Error string instead of throwing', async () => {
  const store = freshStore()
  const msg = await execCreateRoutine({
    flavor: 'chat', prompt: 42, scheduleDisplay: 'd', scheduleRule: { kind: 'interval', everyMs: 1000 },
    modelKey: 'm', agentId: 'a',
  }, store)
  assert.match(msg, /^Error:/)
  assert.match(msg, /prompt must be a string/)
  assert.equal(store.listRoutines().length, 0)
})

test('execCreateRoutine: whitespace around prompt/scheduleDisplay/modelKey is trimmed', async () => {
  const store = freshStore()
  await execCreateRoutine({
    flavor: 'chat', prompt: '  do a thing  ', scheduleDisplay: '  daily  ',
    scheduleRule: { kind: 'interval', everyMs: 1000 }, modelKey: '  m  ', agentId: 'a',
  }, store)
  const [r] = store.listRoutines()
  assert.equal(r.prompt, 'do a thing')
  assert.equal(r.scheduleDisplay, 'daily')
  assert.equal(r.modelKey, 'm')
})

// ── list_routines ─────────────────────────────────────────────────────────

test('execListRoutines: empty store says so plainly', () => {
  assert.equal(execListRoutines({}, freshStore()), 'No routines exist yet.')
})

test('execListRoutines: lists id, status, flavor, schedule and prompt', () => {
  const store = freshStore()
  const r = store.createRoutine({ flavor: 'chat', prompt: 'Summarize my inbox', scheduleDisplay: 'Runs daily at 9:00 AM', scheduleRule: { kind: 'daily', hour: 9, minute: 0 }, modelKey: 'm', agentId: 'a' })
  const out = execListRoutines({}, store)
  assert.match(out, new RegExp(r.id))
  assert.match(out, /pending_confirmation/)
  assert.match(out, /Summarize my inbox/)
  assert.match(out, /chat/)
  assert.match(out, /Runs daily at 9:00 AM/)
})

test('execListRoutines: one line per routine', () => {
  const store = freshStore()
  chatRoutine(store, 'first')
  chatRoutine(store, 'second')
  const lines = execListRoutines({}, store).split('\n')
  assert.equal(lines.length, 2)
  assert.ok(lines.every((l) => l.startsWith('- ')))
})

// ── update_routine (two-phase confirm) ───────────────────────────────────

test('execUpdateRoutine: without confirm, previews the diff and changes nothing', () => {
  const store = freshStore()
  const r = store.createRoutine({ flavor: 'chat', prompt: 'old prompt', scheduleDisplay: 'd', scheduleRule: { kind: 'interval', everyMs: 1000 }, modelKey: 'm', agentId: 'a' })
  const out = execUpdateRoutine({ routineId: r.id, prompt: 'new prompt' }, store)
  assert.match(out, /PREVIEW/)
  assert.match(out, /old prompt/)
  assert.match(out, /new prompt/)
  assert.equal(store.getRoutine(r.id)?.prompt, 'old prompt', 'must not apply without confirm: true')
})

/** Regression guard for the whole point of the two-phase gate: a preview call must be a pure
 *  read. Compares the ENTIRE stored row before/after — not just the field being previewed — so a
 *  future refactor that accidentally writes anything at all (including a bare `updated_at` touch
 *  from an empty-patch updateRoutine call) fails here. */
test('execUpdateRoutine: a preview call mutates no field of the stored routine at all', () => {
  const store = freshStore()
  const r = store.createRoutine({
    flavor: 'code', prompt: 'old prompt', scheduleDisplay: 'old display',
    scheduleRule: { kind: 'interval', everyMs: 1000 }, modelKey: 'old-model',
    workspacePath: 'D:\\old', codingAgent: 'pi', permissionMode: 'ask',
  })
  store.confirmRoutine(r.id, '2030-01-01T00:00:00.000Z')
  const before = JSON.stringify(store.getRoutine(r.id))

  const out = execUpdateRoutine({
    routineId: r.id, prompt: 'new prompt', scheduleDisplay: 'new display',
    scheduleRule: { kind: 'daily', hour: 6, minute: 30 }, modelKey: 'new-model',
    workspacePath: 'D:\\new', codingAgent: 'claude_cli', permissionMode: 'auto',
  }, store)

  assert.match(out, /PREVIEW/)
  assert.equal(JSON.stringify(store.getRoutine(r.id)), before, 'preview must not write anything')
})

test('execUpdateRoutine: confirm: false is treated as a preview, not an apply', () => {
  const store = freshStore()
  const r = chatRoutine(store, 'old prompt')
  const out = execUpdateRoutine({ routineId: r.id, prompt: 'new prompt', confirm: false }, store)
  assert.match(out, /PREVIEW/)
  assert.equal(store.getRoutine(r.id)?.prompt, 'old prompt')
})

test('execUpdateRoutine: a truthy-but-not-true confirm is still only a preview', () => {
  const store = freshStore()
  const r = chatRoutine(store, 'old prompt')
  const out = execUpdateRoutine({ routineId: r.id, prompt: 'new prompt', confirm: 'yes' }, store)
  assert.match(out, /PREVIEW/)
  assert.equal(store.getRoutine(r.id)?.prompt, 'old prompt')
})

test('execUpdateRoutine: with confirm: true, actually applies the change', () => {
  const store = freshStore()
  const r = store.createRoutine({ flavor: 'chat', prompt: 'old prompt', scheduleDisplay: 'd', scheduleRule: { kind: 'interval', everyMs: 1000 }, modelKey: 'm', agentId: 'a' })
  const out = execUpdateRoutine({ routineId: r.id, prompt: 'new prompt', confirm: true }, store)
  assert.match(out, /Updated/)
  assert.equal(store.getRoutine(r.id)?.prompt, 'new prompt')
})

test('execUpdateRoutine: applying trims string fields and leaves untouched fields alone', () => {
  const store = freshStore()
  const r = chatRoutine(store, 'old prompt')
  execUpdateRoutine({ routineId: r.id, prompt: '  new prompt  ', confirm: true }, store)
  const after = store.getRoutine(r.id)
  assert.equal(after?.prompt, 'new prompt')
  assert.equal(after?.scheduleDisplay, 'd')
  assert.equal(after?.modelKey, 'm')
})

test('execUpdateRoutine: an unrecognized permissionMode is rejected even with confirm: true', () => {
  const store = freshStore()
  const r = store.createRoutine({ flavor: 'chat', prompt: 'x', scheduleDisplay: 'd', scheduleRule: { kind: 'interval', everyMs: 1000 }, modelKey: 'm', agentId: 'a' })
  const out = execUpdateRoutine({ routineId: r.id, permissionMode: 'sudo', confirm: true }, store)
  assert.match(out, /^Error:/)
  assert.match(out, /permissionMode/)
  assert.equal(store.getRoutine(r.id)?.permissionMode, undefined)
})

test('execUpdateRoutine: a malformed scheduleRule is rejected even with confirm: true', () => {
  const store = freshStore()
  const r = chatRoutine(store)
  const out = execUpdateRoutine({ routineId: r.id, scheduleRule: { kind: 'monthly' }, confirm: true }, store)
  assert.match(out, /^Error:/)
  assert.match(out, /scheduleRule\.kind/)
  assert.deepEqual(store.getRoutine(r.id)?.scheduleRule, { kind: 'interval', everyMs: 1000 })
})

test('execUpdateRoutine: a partial daily scheduleRule (no minute) is rejected', () => {
  const store = freshStore()
  const r = chatRoutine(store)
  const out = execUpdateRoutine({ routineId: r.id, scheduleRule: { kind: 'daily', hour: 9 }, confirm: true }, store)
  assert.match(out, /^Error:/)
  assert.match(out, /scheduleRule\.minute/)
  assert.deepEqual(store.getRoutine(r.id)?.scheduleRule, { kind: 'interval', everyMs: 1000 })
})

test('execUpdateRoutine: an empty prompt is rejected', () => {
  const store = freshStore()
  const r = chatRoutine(store, 'keep me')
  const out = execUpdateRoutine({ routineId: r.id, prompt: '   ', confirm: true }, store)
  assert.match(out, /^Error:/)
  assert.match(out, /prompt/)
  assert.equal(store.getRoutine(r.id)?.prompt, 'keep me')
})

test('execUpdateRoutine: an empty workspacePath on a code routine is rejected', () => {
  const store = freshStore()
  const r = store.createRoutine({
    flavor: 'code', prompt: 'x', scheduleDisplay: 'd', scheduleRule: { kind: 'interval', everyMs: 1000 },
    modelKey: 'm', workspacePath: 'D:\\repo', codingAgent: 'pi',
  })
  const out = execUpdateRoutine({ routineId: r.id, workspacePath: '  ', confirm: true }, store)
  assert.match(out, /^Error:/)
  assert.match(out, /workspacePath/)
  assert.equal(store.getRoutine(r.id)?.workspacePath, 'D:\\repo')
})

test('execUpdateRoutine: an empty modelKey is rejected', () => {
  const store = freshStore()
  const r = chatRoutine(store)
  const out = execUpdateRoutine({ routineId: r.id, modelKey: '', confirm: true }, store)
  assert.match(out, /^Error:/)
  assert.match(out, /modelKey/)
  assert.equal(store.getRoutine(r.id)?.modelKey, 'm')
})

test('execUpdateRoutine: with no fields to change at all, errors and changes nothing', () => {
  const store = freshStore()
  const r = chatRoutine(store, 'unchanged')
  const before = JSON.stringify(store.getRoutine(r.id))
  const out = execUpdateRoutine({ routineId: r.id }, store)
  assert.match(out, /^Error:/)
  assert.match(out, /at least one field/)
  assert.equal(JSON.stringify(store.getRoutine(r.id)), before)
})

test('execUpdateRoutine: confirm alone (with no real field) is not a change', () => {
  const store = freshStore()
  const r = chatRoutine(store)
  const out = execUpdateRoutine({ routineId: r.id, confirm: true }, store)
  assert.match(out, /^Error:/)
  assert.match(out, /at least one field/)
})

test('execUpdateRoutine: changing an ACTIVE routine\'s schedule recomputes nextFireAt', () => {
  const store = freshStore()
  const r = chatRoutine(store)
  store.confirmRoutine(r.id, '2020-01-01T00:00:00.000Z')
  execUpdateRoutine({ routineId: r.id, scheduleRule: { kind: 'interval', everyMs: 3_600_000 }, confirm: true }, store)
  const after = store.getRoutine(r.id)
  assert.equal(after?.status, 'active')
  assert.ok(after?.nextFireAt && Date.parse(after.nextFireAt) > Date.now(), 'stale next_fire_at must be recomputed')
})

test('execUpdateRoutine: changing a pending routine\'s schedule leaves nextFireAt null', () => {
  const store = freshStore()
  const r = chatRoutine(store)
  execUpdateRoutine({ routineId: r.id, scheduleRule: { kind: 'daily', hour: 7, minute: 15 }, confirm: true }, store)
  const after = store.getRoutine(r.id)
  assert.equal(after?.status, 'pending_confirmation')
  assert.equal(after?.nextFireAt, null, 'an unconfirmed routine must stay unarmed')
})

test('execUpdateRoutine: cannot change status or nextFireAt (no back door into active)', () => {
  const store = freshStore()
  const r = chatRoutine(store)
  const out = execUpdateRoutine({ routineId: r.id, status: 'active', nextFireAt: '2020-01-01T00:00:00.000Z', confirm: true }, store)
  assert.match(out, /^Error:/, 'status/nextFireAt are not updatable fields, so this is an empty patch')
  const after = store.getRoutine(r.id)
  assert.equal(after?.status, 'pending_confirmation')
  assert.equal(after?.nextFireAt, null)
})

test('execUpdateRoutine: unknown routineId is rejected', () => {
  const out = execUpdateRoutine({ routineId: 'nope', prompt: 'x' }, freshStore())
  assert.match(out, /^Error:/)
})

test('execUpdateRoutine: a missing routineId is rejected', () => {
  const out = execUpdateRoutine({ prompt: 'x' }, freshStore())
  assert.match(out, /^Error:/)
  assert.match(out, /routineId/)
})

// ── delete_routine (two-phase confirm) ───────────────────────────────────

test('execDeleteRoutine: without confirm, previews and deletes nothing', () => {
  const store = freshStore()
  const r = store.createRoutine({ flavor: 'chat', prompt: 'x', scheduleDisplay: 'd', scheduleRule: { kind: 'interval', everyMs: 1000 }, modelKey: 'm', agentId: 'a' })
  store.createRoutineRun({ routineId: r.id, configSnapshot: '{}' })
  const out = execDeleteRoutine({ routineId: r.id }, store)
  assert.match(out, /PREVIEW/)
  assert.ok(store.getRoutine(r.id), 'must not delete without confirm: true')
})

/** Delete's half of the preview-purity guard (see the update_routine counterpart). */
test('execDeleteRoutine: a preview leaves both the routine row and its run history untouched', () => {
  const store = freshStore()
  const r = chatRoutine(store)
  store.createRoutineRun({ routineId: r.id, configSnapshot: '{}' })
  store.createRoutineRun({ routineId: r.id, configSnapshot: '{}' })
  const before = JSON.stringify(store.getRoutine(r.id))

  const out = execDeleteRoutine({ routineId: r.id }, store)

  assert.match(out, /2 run\(s\)/)
  assert.equal(JSON.stringify(store.getRoutine(r.id)), before)
  assert.equal(store.listRoutineRuns(r.id).length, 2)
})

test('execDeleteRoutine: confirm: false is treated as a preview', () => {
  const store = freshStore()
  const r = chatRoutine(store)
  const out = execDeleteRoutine({ routineId: r.id, confirm: false }, store)
  assert.match(out, /PREVIEW/)
  assert.ok(store.getRoutine(r.id))
})

test('execDeleteRoutine: previewing a routine with no run history reports 0 runs', () => {
  const store = freshStore()
  const r = chatRoutine(store)
  const out = execDeleteRoutine({ routineId: r.id }, store)
  assert.match(out, /0 run\(s\)/)
  assert.ok(store.getRoutine(r.id))
})

test('execDeleteRoutine: with confirm: true, deletes the routine and its run history', () => {
  const store = freshStore()
  const r = store.createRoutine({ flavor: 'chat', prompt: 'x', scheduleDisplay: 'd', scheduleRule: { kind: 'interval', everyMs: 1000 }, modelKey: 'm', agentId: 'a' })
  store.createRoutineRun({ routineId: r.id, configSnapshot: '{}' })
  const out = execDeleteRoutine({ routineId: r.id, confirm: true }, store)
  assert.match(out, /Deleted/)
  assert.equal(store.getRoutine(r.id), null)
  assert.equal(store.listRoutineRuns(r.id).length, 0)
})

test('execDeleteRoutine: deleting a routine with no run history works too', () => {
  const store = freshStore()
  const r = chatRoutine(store)
  const out = execDeleteRoutine({ routineId: r.id, confirm: true }, store)
  assert.match(out, /Deleted/)
  assert.equal(store.getRoutine(r.id), null)
})

test('execDeleteRoutine: deleting one routine leaves the others alone', () => {
  const store = freshStore()
  const keep = chatRoutine(store, 'keep')
  const drop = chatRoutine(store, 'drop')
  execDeleteRoutine({ routineId: drop.id, confirm: true }, store)
  assert.equal(store.listRoutines().length, 1)
  assert.equal(store.getRoutine(keep.id)?.prompt, 'keep')
})

test('execDeleteRoutine: unknown routineId is rejected', () => {
  const out = execDeleteRoutine({ routineId: 'nope', confirm: true }, freshStore())
  assert.match(out, /^Error:/)
})

test('execDeleteRoutine: a missing routineId is rejected', () => {
  const out = execDeleteRoutine({ confirm: true }, freshStore())
  assert.match(out, /^Error:/)
  assert.match(out, /routineId/)
})

// ── run_routine_now ───────────────────────────────────────────────────────

test('execRunRoutineNow: a pending_confirmation routine cannot be run', async () => {
  const store = freshStore()
  const r = store.createRoutine({ flavor: 'chat', prompt: 'x', scheduleDisplay: 'd', scheduleRule: { kind: 'interval', everyMs: 1000 }, modelKey: 'm', agentId: 'a' })
  const out = await execRunRoutineNow({ routineId: r.id }, store, neverCalled)
  assert.match(out, /^Error:/)
  assert.match(out, /pending confirmation/)
})

test('execRunRoutineNow: an active routine calls the injected runNow and reports success', async () => {
  const store = freshStore()
  const r = store.createRoutine({ flavor: 'chat', prompt: 'x', scheduleDisplay: 'd', scheduleRule: { kind: 'interval', everyMs: 1000 }, modelKey: 'm', agentId: 'a' })
  store.confirmRoutine(r.id, new Date().toISOString())
  let calledWith: string | null = null
  const runNow = async (id: string) => { calledWith = id; return { ok: true as const } }
  const out = await execRunRoutineNow({ routineId: r.id }, store, runNow)
  assert.equal(calledWith, r.id)
  assert.match(out, /running now/)
})

test('execRunRoutineNow: a PAUSED routine can still be triggered manually', async () => {
  const store = freshStore()
  const r = chatRoutine(store)
  store.confirmRoutine(r.id, new Date().toISOString())
  store.updateRoutine(r.id, { status: 'paused', nextFireAt: null })
  let called = false
  const out = await execRunRoutineNow({ routineId: r.id }, store, async () => { called = true; return { ok: true as const } })
  assert.equal(called, true, 'only pending_confirmation blocks a manual run (matches RoutineScheduler.runNow)')
  assert.match(out, /running now/)
})

test('execRunRoutineNow: reports the reason when runNow reports failure', async () => {
  const store = freshStore()
  const r = store.createRoutine({ flavor: 'chat', prompt: 'x', scheduleDisplay: 'd', scheduleRule: { kind: 'interval', everyMs: 1000 }, modelKey: 'm', agentId: 'a' })
  store.confirmRoutine(r.id, new Date().toISOString())
  const runNow = async () => ({ ok: false as const, reason: 'engine busy' })
  const out = await execRunRoutineNow({ routineId: r.id }, store, runNow)
  assert.match(out, /Could not run/)
  assert.match(out, /engine busy/)
})

test('execRunRoutineNow: a throwing runNow becomes an Error string, not a rejected promise', async () => {
  const store = freshStore()
  const r = chatRoutine(store)
  store.confirmRoutine(r.id, new Date().toISOString())
  const out = await execRunRoutineNow({ routineId: r.id }, store, async () => { throw new Error('scheduler exploded') })
  assert.match(out, /^Error:/)
  assert.match(out, /scheduler exploded/)
})

test('execRunRoutineNow: unknown routineId is rejected without calling runNow', async () => {
  const out = await execRunRoutineNow({ routineId: 'nope' }, freshStore(), neverCalled)
  assert.match(out, /^Error:/)
})

test('execRunRoutineNow: a missing routineId is rejected without calling runNow', async () => {
  const out = await execRunRoutineNow({}, freshStore(), neverCalled)
  assert.match(out, /^Error:/)
  assert.match(out, /routineId/)
})

test('execRunRoutineNow: running a routine does not itself change its stored state', async () => {
  const store = freshStore()
  const r = chatRoutine(store)
  store.confirmRoutine(r.id, '2030-01-01T00:00:00.000Z')
  const before = JSON.stringify(store.getRoutine(r.id))
  await execRunRoutineNow({ routineId: r.id }, store, async () => ({ ok: true as const }))
  assert.equal(JSON.stringify(store.getRoutine(r.id)), before)
})

// ── tool definitions (the model-facing contract) ──────────────────────────

test('tool definitions expose exactly the five expected names', () => {
  assert.deepEqual(
    [CREATE_ROUTINE_TOOL, LIST_ROUTINES_TOOL, UPDATE_ROUTINE_TOOL, DELETE_ROUTINE_TOOL, RUN_ROUTINE_NOW_TOOL]
      .map((t) => t.function.name),
    ['create_routine', 'list_routines', 'update_routine', 'delete_routine', 'run_routine_now'],
  )
})

/** Deliberate design property, not an oversight: create_routine has NO confirm flag because
 *  ConversationStore.createRoutine() hardcodes 'pending_confirmation' — the gate is server-side
 *  state. update/delete DO need one because Phase 1's REST layer applies them immediately. */
test('only update_routine and delete_routine expose a confirm flag', () => {
  const hasConfirm = (t: { function: { parameters?: Record<string, unknown> } }) =>
    'confirm' in ((t.function.parameters?.properties ?? {}) as Record<string, unknown>)
  assert.equal(hasConfirm(CREATE_ROUTINE_TOOL), false)
  assert.equal(hasConfirm(LIST_ROUTINES_TOOL), false)
  assert.equal(hasConfirm(RUN_ROUTINE_NOW_TOOL), false)
  assert.equal(hasConfirm(UPDATE_ROUTINE_TOOL), true)
  assert.equal(hasConfirm(DELETE_ROUTINE_TOOL), true)
})

test('no tool exposes a way to confirm/activate a routine or set its status', () => {
  const all = [CREATE_ROUTINE_TOOL, LIST_ROUTINES_TOOL, UPDATE_ROUTINE_TOOL, DELETE_ROUTINE_TOOL, RUN_ROUTINE_NOW_TOOL]
  for (const t of all) {
    const props = Object.keys((t.function.parameters?.properties ?? {}) as Record<string, unknown>)
    assert.equal(props.includes('status'), false, `${t.function.name} must not expose status`)
    assert.equal(props.includes('nextFireAt'), false, `${t.function.name} must not expose nextFireAt`)
  }
  assert.equal(all.some((t) => /confirm_routine|activate/.test(t.function.name)), false)
})

test('create_routine requires the fields validateCreate treats as mandatory', () => {
  assert.deepEqual(
    CREATE_ROUTINE_TOOL.function.parameters.required,
    ['flavor', 'prompt', 'scheduleDisplay', 'scheduleRule', 'modelKey'],
  )
})

test('update_routine and delete_routine require routineId', () => {
  assert.deepEqual(UPDATE_ROUTINE_TOOL.function.parameters.required, ['routineId'])
  assert.deepEqual(DELETE_ROUTINE_TOOL.function.parameters.required, ['routineId'])
  assert.deepEqual(RUN_ROUTINE_NOW_TOOL.function.parameters.required, ['routineId'])
})
