// `activeWork()` answers "what would a primary-engine load interrupt right now?" server-side, for
// the Jev-load confirmation (ADR-434 (i)(3): ask only when something is actively running, and
// name it). Chats, Code turns and routine runs are listed by name; an API client's generation has
// no item of its own and shows as `engineGenerating`.
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
}

function depsWith(library: Library, running: Running = {}, optional = { codeRuns: true, routineScheduler: true }): Deps {
  return {
    db: {
      getConversation: (id: string) => library.conversations?.[id] ?? null,
      getAgentRun: (id: string) => library.agentRuns?.[id] ?? null,
      getRoutine: (id: string) => library.routines?.[id] ?? null,
    },
    manager: {
      status: () => ({ state: running.engineState ?? 'running' }),
      sessionStats: () => ({ activeRequests: running.activeRequests ?? 0 }),
    },
    ...(optional.codeRuns ? { codeRuns: { activeSessionIds: () => running.codeSessions ?? [] } } : {}),
    ...(optional.routineScheduler ? { routineScheduler: { runningRoutineIds: () => running.routines ?? [] } } : {}),
  } as unknown as Deps
}

const noChats = () => []

test('one chat, one Code turn and one routine run are listed with their titles and names', () => {
  const d = depsWith(
    {
      conversations: { 'chat-1': { title: 'Trip planning' }, 'code-conv-1': { title: 'Fix the login bug' } },
      agentRuns: { 'session-1': { convId: 'code-conv-1' } },
      routines: { 'routine-1': { prompt: 'Morning digest' } },
    },
    { codeSessions: ['session-1'], routines: ['routine-1'] },
  )

  assert.deepEqual(activeWork(d, () => ['chat-1']), {
    items: [
      { kind: 'chat', id: 'chat-1', label: 'Trip planning' },
      { kind: 'code', id: 'session-1', label: 'Fix the login bug' },
      { kind: 'routine', id: 'routine-1', label: 'Morning digest' },
    ],
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

  assert.deepEqual(activeWork(d, () => ['chat-2', 'chat-gone']).items.map((i) => i.label), [
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

  assert.deepEqual(activeWork(d, noChats), { items: [], engineGenerating: false })
})

test('the default chat source is the real in-flight chat list (nothing in flight here)', () => {
  assert.deepEqual(activeWork(depsWith({})), { items: [], engineGenerating: false })
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
    engineGenerating: true,
  })
})
