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
import { registerApi } from './routes'
import { lanAuth, provisionRemoteApiKey } from '../auth'
import { defaultConfig } from '../config/config'
import type { LinkCapability } from '../link/types'
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
    // What the route adds for the Android app's poll (downloads, status) reads.
    downloads: { list: () => [] },
    modelRouter: { aliveSlots: () => [], poolModelCount: () => 0 },
    store: { snapshot: () => ({ apiKeys: [], daemon: {} }) },
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
    downloads: [],
    status: { engine: { state: 'running' }, model: null, poolModels: 0, jev: null, laya: null, serving: { lan: false, remote: false, linkPeers: 0 } },
  })
})

// ── What the Android app's poll read from two more routes ──────────────────────────────────────────────────────────
// Every 3 s its EngineService asked GET /api/v1/downloads and GET /api/v1/activity, and GET /api/v1/status when idle,
// each over a connection of its own plus one for the app's proof: 4 to 6 loopback connections a tick. The activity
// now carries what it read from the other two, in their names and shapes, to a caller those routes would answer.

const INGRESS_PORT = 6997
const ROWS = [
  { id: 'd1', name: 'qwen3-8b-q4.gguf', status: 'downloading', received: 1_000_000, total: 5_000_000, bytesPerSec: 250_000, repo: 'Qwen/Qwen3-8B-GGUF', url: 'https://hf.co/x', dest: '/m/qwen3-8b-q4.gguf', error: null },
  { id: 'd2', name: 'gemma-2b.gguf', status: 'queued', received: 0, total: 0, bytesPerSec: 0, repo: '', url: 'https://example.com/g', dest: '/m/gemma-2b.gguf', error: null },
  { id: 'd3', name: 'paused.gguf', status: 'paused', received: 5, total: 10, bytesPerSec: 0, repo: '', url: '', dest: '/m/p', error: null },
  { id: 'd4', name: 'done.gguf', status: 'done', received: 10, total: 10, bytesPerSec: 0, repo: '', url: '', dest: '/m/d', error: null },
]

/** The real /api/v1 routes (registerApi: status, downloads and activity together) over doubles of what they read: a
 *  chat model running in the primary, a Jev model and a Laya model in pool slots, LAN access on. */
function apiDeps(): Deps {
  const cfg = defaultConfig()
  const entries: Record<string, object> = {
    'jev|q|1': { key: 'jev|q|1', name: 'Sentiment', jev: { labels: ['pos', 'neg'] } },
    'laya|q|1': { key: 'laya|q|1', name: 'Laya One', laya: { checkpoints: [] } },
  }
  return {
    version: 'test',
    bindHost: '0.0.0.0',
    store: { snapshot: () => cfg, update: (fn: (c: typeof cfg) => void) => fn(cfg), dir: () => '/nonexistent' },
    manager: {
      currentOpts: () => null,
      restartOpts: () => null,
      status: () => ({ state: 'running', err: null, port: 8081, pid: 1, model: { key: 'qwen|q4|1', name: 'Qwen3 8B', quant: 'Q4', ctx: 4096, vision: false } }),
      launchCommand: () => undefined,
      parallelSlots: () => null,
      sessionStats: () => ({ activeRequests: 0 }),
      liveGeneration: () => null,
    },
    registry: { active: () => ({ id: 'eng-1', name: 'llama.cpp', kind: 'llama.cpp', binPath: '/opt/llama-server' }) },
    modelRouter: {
      aliveSlots: () => [
        { modelKey: 'jev|q|1', state: 'running', primary: false, lastUsedMs: 2 },
        { modelKey: 'laya|q|1', state: 'running', primary: false, lastUsedMs: 1 },
      ],
      poolModelCount: () => 2,
    },
    scanner: { get: (key: string) => entries[key] },
    bench: { isRunning: () => false, status: () => ({ state: 'idle' }) },
    downloads: { list: () => ROWS, activeCount: () => 2 },
    provision: { get: () => undefined },
    build: { get: () => undefined },
    db: { getConversation: () => null, getAgentRun: () => null, getRoutine: () => null },
    agentTasks: { list: () => [] },
    remote: { ingressPort: () => INGRESS_PORT, activeProvider: () => cfg.remoteAccess.provider, state: () => ({ kind: 'off' }), url: () => null },
  } as unknown as Deps
}

async function getJson(d: Deps, path: string, token?: string): Promise<Record<string, unknown>> {
  const app = new Hono()
  app.use('*', lanAuth(d))
  registerApi(app, d)
  const res = token
    ? await app.request(`http://local.test${path}`, { headers: { 'X-TurboLLM-Auth': token } },
      { incoming: { socket: { localPort: INGRESS_PORT, remoteAddress: '127.0.0.1', remotePort: 55555, remoteFamily: 'IPv4' } } } as never)
    : await app.request(`http://127.0.0.1:6996${path}`, {}, { incoming: { socket: { localPort: 6996, remoteAddress: '127.0.0.1', remotePort: 55555, remoteFamily: 'IPv4' } } } as never)
  assert.equal(res.status, 200, `${path}: ${await res.clone().text()}`)
  return await res.json() as Record<string, unknown>
}

test('GET /api/v1/activity carries the live downloads and the status fields the Android app\'s poll reads, as their own routes give them', async () => {
  const d = apiDeps()
  const activity = await getJson(d, '/api/v1/activity')
  const status = await getJson(d, '/api/v1/status')
  const { downloads } = await getJson(d, '/api/v1/downloads') as { downloads: Array<Record<string, unknown>> }

  // The running and queued rows (the two the poll counts as busy), with the fields its notification reads.
  const fields = ['name', 'status', 'received', 'total', 'bytesPerSec']
  const live = downloads.filter((r) => r.status === 'downloading' || r.status === 'queued')
    .map((r) => Object.fromEntries(fields.map((f) => [f, r[f]])))
  assert.deepEqual(activity.downloads, live)
  assert.equal(live.length, 2)

  const pick = (o: unknown, keys: string[]) => (o === null ? null : Object.fromEntries(keys.map((k) => [k, (o as Record<string, unknown>)[k]])))
  assert.deepEqual(activity.status, {
    engine: pick(status.engine, ['state']),
    model: pick(status.model, ['name']),
    poolModels: status.poolModels,
    jev: pick(status.jev, ['name']),
    laya: pick(status.laya, ['name']),
    serving: status.serving,
  })
  assert.deepEqual(activity.status, {
    engine: { state: 'running' }, model: { name: 'Qwen3 8B' }, poolModels: 2, jev: { name: 'Sentiment' }, laya: { name: 'Laya One' },
    serving: { lan: true, remote: false, linkPeers: 0 },
  })
  // What the activity said before is unchanged.
  assert.deepEqual([activity.items, activity.waiting, activity.engineGenerating], [[], [], false])
})

test('GET /api/v1/activity gives a remote-access token the downloads and status only when it may read those routes', async () => {
  const d = apiDeps()
  const asToken = async (capabilities: LinkCapability[]) =>
    getJson(d, '/api/v1/activity', provisionRemoteApiKey(d, { kind: 'remote', capabilities }))
  const loadOnly = await asToken(['models:use', 'models:load'])
  assert.deepEqual(Object.keys(loadOnly).sort(), ['engineGenerating', 'items', 'waiting'])
  assert.deepEqual(Object.keys(await asToken(['models:load', 'downloads:read'])).sort(), ['downloads', 'engineGenerating', 'items', 'waiting'])
  assert.deepEqual(Object.keys(await asToken(['models:load', 'config:read'])).sort(), ['engineGenerating', 'items', 'status', 'waiting'])
  assert.deepEqual(Object.keys(await asToken(['models:load', 'downloads:read', 'config:read'])).sort(),
    ['downloads', 'engineGenerating', 'items', 'status', 'waiting'])
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
