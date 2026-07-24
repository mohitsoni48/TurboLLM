import { test, expect } from '@playwright/test'
import { mockCodeApp, type CodeMessageFixture } from './fixtures/code-mocks'

// FINAL GATE (task #30): individual Code features were each tested in isolation across ~15
// separate tasks this session. Nobody has checked whether they compose visually in ONE view
// without clashing — spacing/overlap/inconsistent weight/confusing ordering are exactly the class
// of bug per-feature automated tests structurally can't catch (spec 16 §9). This renders a single
// session with every PERSISTED/mockable feature family visible at once: a plain instruction, a
// shell `!command` entry, an edit with a real diff, and a queued follow-up card at the tail.
//
// SCOPE NOTE, stated up front rather than discovered by a reader: turn dividers, the todo
// checklist, and the retry banner are confirmed live-SSE-only — no persisted DB representation at
// all (TurnDivider/TodoChecklist's own doc comments in CodeTranscript.tsx say so explicitly, and
// code-run-manager.ts's sink only ever stores a tool call's FINAL status, never a live one). A real
// attempt was made to mock a genuinely-open `/stream` connection for this spec (see
// fixtures/code-mocks.ts's comment on the stream route) and abandoned after confirming empirically
// — not assumed — that Playwright's `route.fulfill()` doesn't surface a mocked SSE body to the
// app's fetch reader in a way that ever renders, even with an accurate Content-Length. Verifying
// those three live-only states in combination with everything else here needs a real daemon
// connection, matching spec 16 §8's own documented limitation for this exact class of state — not
// a gap unique to this spec.

const SESSION = { id: 's-combined', title: 'Add rate limiting to the API', repoRoot: '/repo/backend-api', branch: 'main', add: 42, del: 8 }

const MESSAGES: CodeMessageFixture[] = [
  { id: 'u1', seq: 1, role: 'user', content: 'Add rate limiting to the public API and check it works.' },
  {
    id: 'a1', seq: 2, role: 'assistant', content: 'Added a token-bucket limiter.',
    toolCalls: [{
      id: 't1', name: 'edit', args: { path: 'src/middleware/rate-limit.ts' },
      diff: '@@ -1,3 +1,4 @@\n import { Hono } from \'hono\'\n+import { rateLimiter } from \'./token-bucket\'\n context\n context',
      patch: '@@ -1,3 +1,4 @@\n import { Hono } from \'hono\'\n+import { rateLimiter } from \'./token-bucket\'\n context\n context',
    }],
    // A leading text block is required for `content` to actually render anywhere — CodeTranscript
    // prefers `timeline` over `content` whenever a timeline is present (true chronological
    // interleave), so a tool-only timeline genuinely shows no commentary text at all, matching
    // real interleaved-turn rendering (confirmed empirically while building this fixture).
    timeline: [{ type: 'text', text: 'Added a token-bucket limiter.' }, { type: 'tool', id: 't1' }],
  },
  // A persisted `!command` — a user message carrying a `shell` tool call (ADR-258), rendered via
  // CodeShellEntry with the same --log-* console tokens tool output uses.
  {
    id: 'u2', seq: 3, role: 'user', content: '!npm test -- rate-limit',
    toolCalls: [{ id: 'sh1', name: 'shell', args: { command: 'npm test -- rate-limit' }, result: '3 passing (42ms)' }],
    timeline: [{ type: 'tool', id: 'sh1' }],
  },
]

const QUEUED = [{ userMsgId: 'q1', task: 'Also add a Retry-After header on 429 responses.', kind: 'followUp' as const }]

async function gotoCombined(page: import('@playwright/test').Page, theme: 'light' | 'dark') {
  await page.addInitScript((t) => window.localStorage.setItem('tllm.theme', t), theme)
  await mockCodeApp(page, { session: SESSION, messages: MESSAGES, queued: QUEUED })
  await page.goto(`/workspace/code/${SESSION.id}`)
}

for (const theme of ['light', 'dark'] as const) {
  test(`${theme}: combined view — instruction, shell entry, diff, and a queued follow-up card all render together without clashing`, async ({ page }) => {
    await gotoCombined(page, theme)

    await expect(page.getByText('Added a token-bucket limiter.')).toBeVisible()
    await expect(page.getByText('$ npm test -- rate-limit')).toBeVisible() // CodeShellEntry
    await expect(page.locator('table').first()).toBeVisible() // the diff panel
    await expect(page.getByText('Also add a Retry-After header on 429 responses.')).toBeVisible() // queued card
    await expect(page.getByText('Runs next')).toBeVisible() // queued card's followUp badge

    // No page-level horizontal scroll with this much content stacked in one transcript.
    const { scrollWidth, clientWidth } = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }))
    expect(scrollWidth).toBeLessThanOrEqual(clientWidth)

    // Real DOM order: history in seq order, the queued card strictly AFTER all persisted
    // messages, never interleaved — the ADR-199 ordering invariant CodeTranscript's own `queued`
    // prop doc comment states explicitly.
    const order = await page.evaluate(() => {
      const text = document.body.innerText
      return {
        instructionIdx: text.indexOf('Add rate limiting to the public API'),
        shellIdx: text.indexOf('npm test -- rate-limit'),
        queuedIdx: text.indexOf('Also add a Retry-After header'),
      }
    })
    expect(order.instructionIdx).toBeGreaterThan(-1)
    expect(order.shellIdx).toBeGreaterThan(order.instructionIdx)
    expect(order.queuedIdx).toBeGreaterThan(order.shellIdx)
  })
}
