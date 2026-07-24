import type { Page } from '@playwright/test'

// Shared Playwright network-mock fixtures for Code-screen E2E tests (Phase 0 test suite,
// task #12). Deliberately fully mocked rather than driven against a real daemon: these tests
// assert layout/token/font behavior, which needs to be deterministic and CI-safe, not dependent
// on a loaded model or real session content. `page.route` intercepts every `/api/v1/**` call
// BEFORE the app's own dev-proxy would forward it to a real daemon on :6996 — no real daemon
// needs to be running for these specs at all.

/** Bare-minimum settings payload: only `experimental.code` is read by `RequireCodeEnabled`
 *  (App.tsx) — everything else is left absent since nothing else in these specs reads it. */
const SETTINGS = { experimental: { code: true } }

/** Bare-minimum status payload — enough for Shell/EngineProvisionBanner to render without
 *  crashing on an unexpected shape; values chosen to read as "idle, nothing to report" so no
 *  extra banners compete for space with the elements under test. */
const STATUS = {
  version: '0.0.0-test',
  state: 'stopped',
  engine: { state: 'stopped' },
  model: null,
  downloads: { active: 0 },
  // queries.ts:154 reads `data?.bench.running` — only `.data` is optional-chained, not
  // `.bench` — so an incomplete status mock throws instead of just rendering an idle state.
  // Every real daemon response includes this field, so the gap never surfaces in production.
  bench: { running: false },
}

const MODELS = { models: [], scanning: false, lastScanAt: null }
const CODE_STATS = { totalSessions: 0, totalMinutes: 0, days: [] }

export interface CodeToolCallFixture {
  id: string
  name: string
  args?: Record<string, unknown>
  result?: string
  error?: string
  diff?: string
  patch?: string
  firstChangedLine?: number
}

export interface CodeMessageFixture {
  id: string
  seq: number
  role: 'user' | 'assistant'
  content: string
  reasoning?: string
  toolCalls?: CodeToolCallFixture[]
  /** Interleaved text/tool timeline — omit to fall back to content-then-toolCalls order,
   *  same fallback CodeTranscript.tsx itself uses for pre-timeline-field messages. */
  timeline?: ({ type: 'text'; text: string } | { type: 'tool'; id: string })[]
}

function toMessage(m: CodeMessageFixture) {
  return {
    id: m.id,
    convId: 'conv-1',
    seq: m.seq,
    role: m.role,
    content: m.content,
    reasoning: m.reasoning ?? '',
    attachments: [],
    textAttachments: [],
    toolCalls: (m.toolCalls ?? []).map((t) => ({ args: {}, ...t })),
    timeline: m.timeline,
    stats: {},
    createdAt: '2026-07-24T10:00:00.000Z',
    variantGroup: null,
    isActive: true,
    branchOf: null,
    edited: false,
  }
}

/** Registers route mocks for every API call `CodeHomeScreen`/`CodeSessionScreen` make, plus
 *  fulfills the given session (if any) for both the sidebar list and the detail route. Call
 *  before `page.goto(...)`. */
export interface CodeQueuedFixture {
  userMsgId: string
  task: string
  kind: 'steer' | 'followUp'
}

export async function mockCodeApp(
  page: Page,
  opts: {
    session?: { id: string; title: string; repoRoot: string; branch?: string; add?: number; del?: number; running?: boolean }
    messages?: CodeMessageFixture[]
    /** The server-side message queue (DB-persisted via the session-detail GET response, not
     *  SSE-driven) — safe to render deterministically, unlike live-only state (see the `/stream`
     *  route below). */
    queued?: CodeQueuedFixture[]
  } = {},
): Promise<void> {
  await page.route('**/api/v1/settings', (route) => route.fulfill({ json: SETTINGS }))
  await page.route('**/api/v1/status', (route) => route.fulfill({ json: STATUS }))
  await page.route('**/api/v1/models', (route) => route.fulfill({ json: MODELS }))
  await page.route('**/api/v1/code/stats**', (route) => route.fulfill({ json: CODE_STATS }))

  const { session, messages = [], queued = [] } = opts
  const sidebarRow = session
    ? {
        id: session.id,
        convId: 'conv-1',
        title: session.title,
        status: 'review',
        branch: session.branch ?? '',
        when: 'just now',
        add: session.add ?? 0,
        del: session.del ?? 0,
        mode: 'auto',
        running: session.running ?? false,
        createdAt: '2026-07-24T10:00:00.000Z',
        repoRoot: session.repoRoot,
        archivedAt: undefined,
        clearedUpToMessageId: undefined,
        revertedFromMessageId: undefined,
      }
    : null

  await page.route('**/api/v1/code/sessions?**', (route) => {
    if (route.request().method() !== 'GET') return route.continue()
    return route.fulfill({ json: { sessions: sidebarRow ? [sidebarRow] : [] } })
  })

  if (session) {
    await page.route(`**/api/v1/code/sessions/${session.id}`, (route) => {
      if (route.request().method() !== 'GET') return route.continue()
      return route.fulfill({
        json: {
          session: sidebarRow,
          conversation: {
            id: 'conv-1',
            title: session.title,
            systemPrompt: '',
            modelKey: '',
            sampling: {},
            expertMode: false,
            kind: 'code',
            preserveThinking: true,
            agentMode: 'auto',
            createdAt: '2026-07-24T10:00:00.000Z',
            updatedAt: '2026-07-24T10:00:00.000Z',
            messages: messages.map(toMessage),
          },
          doc: null,
          running: session.running ?? false,
          queued,
        },
      })
    })

    // Live SSE state (turn dividers, the todo checklist, the retry banner — see
    // CodeStreamingEntry/TurnDivider/TodoChecklist's own doc comments) has no persisted DB
    // representation, so it can't be rendered through a mocked GET response the way messages/
    // queued turns can. Mocking a genuinely still-open `/stream` connection was attempted (see
    // this fixture's git history / the FINAL GATE report) and abandoned after confirming
    // empirically that a Playwright `route.fulfill()` response — even a completely well-formed,
    // accurately-length one — never gets its bytes surfaced to the app's fetch reader in a way
    // that renders. Routed to an always-empty, never-live stream here so an unexpected reconnect
    // attempt fails fast/visibly instead of falling through to a real daemon on :6996 — verifying
    // those three live-only states in combination with everything else needs a real daemon
    // connection (spec 16 §8's own documented limitation for this class of state).
    await page.route(`**/api/v1/code/sessions/${session.id}/stream**`, (route) =>
      route.fulfill({ status: 200, contentType: 'text/event-stream', body: '' }))
  }
}
