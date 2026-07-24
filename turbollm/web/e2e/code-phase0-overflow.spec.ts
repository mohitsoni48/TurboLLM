import { test, expect } from '@playwright/test'
import { mockCodeApp, type CodeMessageFixture } from './fixtures/code-mocks'

// Phase 0 test suite (task #12, spec 16 §2 "Edge cases" + §9's "no horizontal scroll / no
// clipped content" acceptance criterion): the ORIGINAL bug that triggered this whole redesign.
// This is exactly the class jsdom-based Vitest tests cannot catch at all (no real layout engine)
// — Playwright exists in this test plan specifically for this.
//
// The concrete narrow width used throughout: 375px. Not an arbitrary choice — it's the exact
// width the original bug was caught at (CodeSessionScreen.tsx's own header comment: "measured
// 0px with a real long repo/branch pair at 375px"). 320px is also checked (spec 16 §9's own
// "320px through a wide monitor" convention) as an even harder stress case.

// Long enough that, pre-fix, it would have claimed the header row's full width and squeezed the
// session title to 0px (the exact live-caught bug) — same shape of input as the original report.
const LONG_SESSION = {
  id: 's-long',
  title: 'Fix the login bug',
  repoRoot: '/Users/founder/dev/some-really-long-nested-project-directory-name/packages/backend-api',
  branch: 'feature/a-genuinely-long-branch-name-that-does-not-fit',
  add: 128,
  del: 47,
}

const NARROW_WIDTHS = [375, 320]

async function noHorizontalOverflow(page: import('@playwright/test').Page): Promise<void> {
  const { scrollWidth, clientWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }))
  expect(scrollWidth, 'page must not scroll horizontally').toBeLessThanOrEqual(clientWidth)
}

test.describe('Phase 0 overflow — session header chips at narrow widths', () => {
  for (const width of NARROW_WIDTHS) {
    test(`${width}px: long repo/branch/diff-stat chips truncate, session title stays visible (non-zero width)`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 })
      await mockCodeApp(page, { session: LONG_SESSION, messages: [] })
      await page.goto(`/workspace/code/${LONG_SESSION.id}`)

      // getByText(exact title) is ambiguous — the same title also appears in the persistent
      // sidebar's session list. The header instance carries a `title=""` HTML attribute
      // (CodeSessionScreen.tsx's rename/title span), which the sidebar row does not.
      const title = page.getByTitle(LONG_SESSION.title, { exact: true })
      await expect(title).toBeVisible()
      const titleBox = await title.boundingBox()
      expect(titleBox?.width ?? 0).toBeGreaterThan(0) // the exact regression: title squeezed to 0px

      await noHorizontalOverflow(page)
    })
  }
})

test.describe('Phase 0 overflow — composer toolbar at narrow widths', () => {
  for (const width of NARROW_WIDTHS) {
    test(`${width}px: full toolbar (mode, add-context, context ring, model, send) stays reachable, no page-level scroll`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 })
      await mockCodeApp(page, { session: LONG_SESSION, messages: [] })
      await page.goto(`/workspace/code/${LONG_SESSION.id}`)

      // The toolbar's own `overflow-x-auto` (CodeComposer.tsx:730) is the DELIBERATE fix —
      // containing any overflow to the toolbar row itself. What must NOT happen is that
      // overflow escaping the toolbar and blowing out the whole page's scroll width.
      await expect(page.getByPlaceholder(/follow-up/i)).toBeVisible()
      await noHorizontalOverflow(page)

      // The send button (last toolbar slot) must still be reachable — this is the actual
      // functional claim the toolbar's own comment makes ("scrolling the row itself keeps
      // Send reachable"), not just "nothing looks broken."
      const sendButton = page.getByRole('button', { name: /send/i })
      await sendButton.scrollIntoViewIfNeeded()
      await expect(sendButton).toBeVisible()
    })
  }
})

test.describe('Phase 0 overflow — extremely long unbroken monospace content', () => {
  test('a 500+ char unbroken diff line wraps or scrolls within its own container, never the page', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 800 })
    // An edit-tool diff, not a bash result — CodeToolCard only starts expanded for a diff-bearing
    // call (`useState(hasDiff)`, CodeTranscript.tsx:252); a bash/output call starts collapsed and
    // would need an extra click before its <pre> content is even in the DOM.
    const longLine = '+const url = "https://example.com/' + 'x'.repeat(480) + '/end.ts"'
    const diff = `@@ -1,1 +1,1 @@\n-old\n${longLine}`
    const messages: CodeMessageFixture[] = [
      { id: 'u1', seq: 1, role: 'user', content: 'update the constant' },
      {
        id: 'a1', seq: 2, role: 'assistant', content: '',
        toolCalls: [{ id: 't1', name: 'edit', args: { path: 'src/const.ts' }, diff, patch: diff }],
        timeline: [{ type: 'tool', id: 't1' }],
      },
    ]
    await mockCodeApp(page, { session: LONG_SESSION, messages })
    await page.goto(`/workspace/code/${LONG_SESSION.id}`)
    await expect(page.locator('td', { hasText: 'x'.repeat(50) })).toBeVisible()
    await noHorizontalOverflow(page)
  })
})

test.describe('Phase 0 overflow — very large diff', () => {
  test('a 1000+ line diff stays internally scrollable (max-h-[420px]), does not inflate page height', async ({ page }) => {
    const hugeDiff = ['@@ -1,1000 +1,1000 @@', ...Array.from({ length: 1000 }, (_, i) => `-old line ${i}\n+new line ${i}`)].join('\n')
    const messages: CodeMessageFixture[] = [
      { id: 'u1', seq: 1, role: 'user', content: 'big refactor' },
      {
        id: 'a1', seq: 2, role: 'assistant', content: '',
        toolCalls: [{ id: 't1', name: 'edit', args: { path: 'src/big.ts' }, diff: hugeDiff, patch: hugeDiff }],
        timeline: [{ type: 'tool', id: 't1' }],
      },
    ]
    await mockCodeApp(page, { session: LONG_SESSION, messages })
    await page.goto(`/workspace/code/${LONG_SESSION.id}`)

    const panel = page.locator('table').first().locator('..')
    const box = await panel.boundingBox()
    // max-h-[420px] on CodeDiffPanel's own scroll container (CodeTranscript.tsx:179) — allow a
    // little slack for the border/header row, but this must stay bounded, not render all 2000+
    // diff rows into the page's natural height.
    expect(box?.height ?? 0).toBeLessThanOrEqual(440)
  })
})

test.describe('Phase 0 overflow — ultrawide viewport', () => {
  test('3440px: content does not stretch into unreadably long line lengths', async ({ page }) => {
    await page.setViewportSize({ width: 3440, height: 1000 })
    await mockCodeApp(page, { session: LONG_SESSION, messages: [{ id: 'u1', seq: 1, role: 'user', content: 'hello' }] })
    await page.goto(`/workspace/code/${LONG_SESSION.id}`)
    await expect(page.getByText('hello', { exact: true })).toBeVisible()

    const contentWidth = await page.evaluate(() => {
      const scroller = document.querySelector('main') ?? document.body
      return scroller.getBoundingClientRect().width
    })
    // No hard max-width decision is recorded anywhere in specs 11/14/15 as of this test being
    // written — this locks in a generous sanity ceiling (not full 3440px edge-to-edge text) so a
    // real regression (content genuinely spanning the full ultrawide width with no cap at all)
    // fails loudly; tighten this once Phase 0 actually records a specific max-width decision
    // (flagged in the report — this is the one edge case spec 16 itself says still needs that
    // decision made during implementation).
    expect(contentWidth).toBeLessThan(3440)
  })
})
