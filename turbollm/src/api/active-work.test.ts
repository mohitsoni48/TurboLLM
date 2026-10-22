// `activeWork()` answers "what would a primary-engine load interrupt right now?" server-side, for
// the Jev-load confirmation (ADR-434 (i)(3): ask only when something is actively running, and
// name it), and "is the daemon busy?" for the Android app's EngineService, which reads `items` and
// `engineGenerating`. Chats, Code turns, routine runs, a model load, an auto-tune and a skill being
// written are listed by name; a chat parked on a tool-call approval is listed apart, in `waiting`;
// an API client's generation has no item of its own and shows as `engineGenerating`.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Hono } from 'hono'
import { activeWork, registerActivityRoutes } from './active-work'
import type { Deps } from '../deps'

interface Library {
  conversations?: Record<string, { title: string }>
  agentRuns?: Record<string, { convId: string }>
  routines?: Record<string, { prompt: string }>
}

interface Running {
  codeSessions?: string[]
  routines?: string[]
  engineState?: string
  activeRequests?: number
  /** The model the engine runs or loads. */
  model?: { key: string; name: string }
  /** An auto-tune run's model key. */
  tuning?: string
  agentTasks?: Array<{ id: string; kind: string; label: string; status: string }>
}

function depsWith(library: Library, running: Running = {}, optional = { codeRuns: true, routineScheduler: true }): Deps {
  return {
    db: {
      getConversation: (id: string) => library.conversations?.[id] ?? null,
      getAgentRun: (id: string) => library.agentRuns?.[id] ?? null,
      getRoutine: (id: string) => library.routines?.[id] ?? null,
    },
    manager: {
      status: () => ({ state: running.engineState ?? 'running', model: running.model ?? null }),
      sessionStats: () => ({ activeRequests: running.activeRequests ?? 0 }),
    },
    bench: {
      isRunning: () => running.tuning !== undefined,
      status: () => (running.tuning !== undefined ? { running: true, modelKey: running.tuning } : { running: false }),
    },
    scanner: { get: (key: string) => (key === 'gemma-27b|q4|1' ? { key, name: 'Gemma 27B' } : undefined) },
    agentTasks: { list: () => running.agentTasks ?? [] },
    ...(optional.codeRuns ? { codeRuns: { activeSessionIds: () => running.codeSessions ?? [] } } : {}),
    ...(optional.routineScheduler ? { routineScheduler: { runningRoutineIds: () => running.routines ?? [] } } : {}),
  } as unknown as Deps
}

const noChats = { inFlight: () => [] }

test('one chat, one Code turn and one routine run are listed with their titles and names', () => {
  const d = depsWith(
    {
      conversations: { 'chat-1': { title: 'Trip planning' }, 'code-conv-1': { title: 'Fix the login bug' } },
      agentRuns: { 'session-1': { convId: 'code-conv-1' } },
      routines: { 'routine-1': { prompt: 'Morning digest' } },
    },
    { codeSessions: ['session-1'], routines: ['routine-1'] },
  )

  assert.deepEqual(activeWork(d, { inFlight: () => ['chat-1'] }), {
    items: [
      { kind: 'chat', id: 'chat-1', label: 'Trip planning' },
      { kind: 'code', id: 'session-1', label: 'Fix the login bug' },
      { kind: 'routine', id: 'routine-1', label: 'Morning digest' },
    ],
    waiting: [],
    engineGenerating: false,
  })
})

test('a Code session whose id is its conversation id (no agent run) still gets the conversation title', () => {
  const d = depsWith({ conversations: { 'code-conv-2': { title: 'Refactor' } } }, { codeSessions: ['code-conv-2'] })

  assert.deepEqual(activeWork(d, noChats).items, [{ kind: 'code', id: 'code-conv-2', label: 'Refactor' }])
})

test('missing or empty titles and names fall back to Untitled', () => {
  const d = depsWith(
    { conversations: { 'chat-2': { title: '' } } },
    { codeSessions: ['session-gone'], routines: ['routine-gone'] },
  )

  assert.deepEqual(activeWork(d, { inFlight: () => ['chat-2', 'chat-gone'] }).items.map((i) => i.label), [
    'Untitled', 'Untitled', 'Untitled', 'Untitled',
  ])
})

test('engineGenerating is true only while the engine runs with a request in progress', () => {
  const generating = (engineState: string, activeRequests: number) =>
    activeWork(depsWith({}, { engineState, activeRequests }), noChats).engineGenerating

  assert.equal(generating('running', 1), true)
  assert.equal(generating('running', 0), false)
  assert.equal(generating('starting', 1), false)
  assert.equal(generating('stopped', 0), false)
})

test('engineGenerating tolerates a manager with no session stats', () => {
  const d = { ...depsWith({}), manager: { status: () => ({ state: 'running' }), sessionStats: () => null } } as unknown as Deps

  assert.equal(activeWork(d, noChats).engineGenerating, false)
})

test('without codeRuns or routineScheduler there are no code or routine items', () => {
  const d = depsWith({}, { codeSessions: ['session-1'], routines: ['routine-1'] }, { codeRuns: false, routineScheduler: false })

  assert.deepEqual(activeWork(d, noChats), { items: [], waiting: [], engineGenerating: false })
})

test('the default chat source is the real in-flight chat list (nothing in flight here)', () => {
  assert.deepEqual(activeWork(depsWith({})), { items: [], waiting: [], engineGenerating: false })
})

test('GET /api/v1/activity answers the active work as JSON', async () => {
  const app = new Hono()
  registerActivityRoutes(app, depsWith(
    { routines: { 'routine-1': { prompt: 'Morning digest' } } },
    { routines: ['routine-1'], activeRequests: 2 },
  ))

  const res = await app.request('/api/v1/activity')

  assert.equal(res.status, 200)
  assert.deepEqual(await res.json(), {
    items: [{ kind: 'routine', id: 'routine-1', label: 'Morning digest' }],
    waiting: [],
    engineGenerating: true,
  })
})

test('a chat parked on a tool-call approval is listed in waiting, not in items', () => {
  const d = depsWith({ conversations: { 'chat-1': { title: 'Trip planning' }, 'chat-2': { title: 'Taxes' } } })

  assert.deepEqual(activeWork(d, { inFlight: () => ['chat-1', 'chat-2'], parked: () => ['chat-2'] }), {
    items: [{ kind: 'chat', id: 'chat-1', label: 'Trip planning' }],
    waiting: [{ kind: 'chat', id: 'chat-2', label: 'Taxes' }],
    engineGenerating: false,
  })
})

test('a chat whose finished reply still has its title or memory call pending is a chat item, once', () => {
  const d = depsWith({ conversations: { 'chat-1': { title: 'New chat' }, 'chat-2': { title: 'Taxes' } } })

  // chat-2 is both: its reply's title call still runs while a new turn of it is parked.
  const work = activeWork(d, { inFlight: () => ['chat-2'], parked: () => ['chat-2'], afterReply: () => ['chat-1', 'chat-2'] })
  assert.deepEqual(work.items, [{ kind: 'chat', id: 'chat-1', label: 'New chat' }, { kind: 'chat', id: 'chat-2', label: 'Taxes' }])
  assert.deepEqual(work.waiting, [], 'listed once, as running')
})

test('a model loading is a load item named after the model; a loaded one is not', () => {
  const model = { key: 'gemma-27b|q4|1', name: 'Gemma 27B' }

  assert.deepEqual(activeWork(depsWith({}, { engineState: 'starting', model }), noChats).items, [
    { kind: 'load', id: 'gemma-27b|q4|1', label: 'Gemma 27B' },
  ])
  assert.deepEqual(activeWork(depsWith({}, { engineState: 'running', model }), noChats).items, [])
  assert.deepEqual(activeWork(depsWith({}, { engineState: 'stopped' }), noChats).items, [])
})

test('an auto-tune run is a tune item named after its model, and its own candidate loads are not a load item', () => {
  const tuning = activeWork(depsWith({}, { engineState: 'starting', model: { key: 'gemma-27b|q4|1', name: 'Gemma 27B' }, tuning: 'gemma-27b|q4|1' }), noChats)

  assert.deepEqual(tuning.items, [{ kind: 'tune', id: 'gemma-27b|q4|1', label: 'Gemma 27B' }])
  assert.deepEqual(activeWork(depsWith({}, { tuning: 'gone|q4|1' }), noChats).items, [{ kind: 'tune', id: 'gone|q4|1', label: 'gone|q4|1' }])
})

test('a skill being written is a skill item; a finished one is not', () => {
  const d = depsWith({}, {
    agentTasks: [
      { id: 't1', kind: 'skill_from_conversation', label: 'Writing a skill from this conversation', status: 'running' },
      { id: 't2', kind: 'skill_from_folder', label: 'Learning from /docs', status: 'running' },
      { id: 't3', kind: 'skill_from_folder', label: 'Learning from /old', status: 'done' },
      { id: 't4', kind: 'skill_from_conversation', label: 'Writing a skill from that one', status: 'failed' },
    ],
  })

  assert.deepEqual(activeWork(d, noChats).items, [
    { kind: 'skill', id: 't1', label: 'Writing a skill from this conversation' },
    // Not the host folder Learn from folder names in its own label: this list also answers a remote-access token.
    { kind: 'skill', id: 't2', label: 'Learning skills from a folder' },
  ])
})

test('a chat parked on an approval is not an engine generation, though its turn holds the generation count', () => {
  // A local turn counts as a generation from its first request to its end (manager.generationStart).
  const parked = depsWith({ conversations: { 'chat-2': { title: 'Taxes' } } }, { activeRequests: 1 })
  const sources = { inFlight: () => ['chat-2'], parked: () => ['chat-2'], parkedGenerations: () => 1 }
  assert.equal(activeWork(parked, sources).engineGenerating, false, 'Android may let the phone sleep while a person is awaited')

  const alsoApi = depsWith({ conversations: { 'chat-2': { title: 'Taxes' } } }, { activeRequests: 2 })
  assert.equal(activeWork(alsoApi, sources).engineGenerating, true, 'an API client\'s request beside it still counts')
})
