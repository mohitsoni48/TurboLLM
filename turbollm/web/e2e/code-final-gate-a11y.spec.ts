import { test, expect } from '@playwright/test'
import { mockCodeApp, type CodeMessageFixture } from './fixtures/code-mocks'

// Final gate (task #30, spec 16 §9 item 4): "Real aria-labels on every new interactive element,
// not just icons." A manual grep can miss things and can't verify the browser's ACTUAL
// accessibility tree — page.getByRole(..., { name }) queries the real computed accessible name
// (aria-label, or native label association, or visible text), the same way a screen reader
// would resolve it, so a false pass here isn't possible the way it is with a source-code regex.
// No axe-core dependency exists in this project (checked package.json) and wasn't added for this
// alone, per the task brief — getByRole/name is the built-in equivalent for "does this control
// have a real accessible name," which is the specific, narrow claim this spec makes.
//
// Deliberately scoped to states reachable through the existing idle-session mock
// (mockCodeApp/code-mocks.ts has no live-SSE support — code-phase0-tokens.spec.ts hit the same
// wall for --toolcard-approval-bg/--status-banner-bg and worked around it with a direct
// CSS-variable probe rather than building live-stream mock infrastructure). The composer's
// Steer/Queue/Stop buttons (only rendered while `live`) are covered instead by
// CodeComposer.test.tsx's existing Vitest+RTL suite, which already asserts on their exact
// aria-label text via component props — a more precise and much cheaper way to pin an
// accessible name to a controlled prop state than faking a live run end-to-end in a real browser.

const SESSION = { id: 's1', title: 'Fix the login bug', repoRoot: '/repo', branch: 'main' }
const MESSAGES: CodeMessageFixture[] = [
  { id: 'u1', seq: 1, role: 'user', content: 'Please fix the pagination bug.' },
  { id: 'a1', seq: 2, role: 'assistant', content: 'Done — fixed the off-by-one.' },
]

test.describe('Final gate — real accessible names on session-screen controls', () => {
  test('session header: rename and session-actions menu both have real accessible names', async ({ page }) => {
    await mockCodeApp(page, { session: SESSION, messages: MESSAGES })
    await page.goto(`/workspace/code/${SESSION.id}`)
    // getByText(title) is ambiguous — the same title also appears in the persistent sidebar's
    // session list (same trick code-phase0-overflow.spec.ts uses: only the HEADER instance
    // carries a `title=""` attribute).
    await expect(page.getByTitle(SESSION.title, { exact: true })).toBeVisible()

    // Fixed by this gate: was icon-only with only a `title` tooltip, no aria-label at all.
    await expect(page.getByRole('button', { name: 'Rename session' })).toBeVisible()
    // The header's own trigger — specifically NOT the sidebar row's per-session one (also fixed
    // by this gate, see ConversationSidebar.tsx: it used to share this exact generic name, which
    // this test caught as a real duplicate-accessible-name collision before that fix landed).
    await expect(page.getByRole('button', { name: 'Session actions', exact: true })).toBeVisible()
  })

  test('the "Export"/"Git…" session-actions menu items expose their real (already-visible) names', async ({ page }) => {
    await mockCodeApp(page, { session: SESSION, messages: MESSAGES })
    await page.goto(`/workspace/code/${SESSION.id}`)
    await page.getByRole('button', { name: 'Session actions', exact: true }).click()
    await expect(page.getByRole('menuitem', { name: /Export/ })).toBeVisible()
    await expect(page.getByRole('menuitem', { name: /Git/ })).toBeVisible()
  })

  test('a persisted message\'s CopyButton has a real accessible name, not just a title tooltip', async ({ page }) => {
    // Fixed by this gate: the shared CopyButton (components/ui/copy-button.tsx) had no
    // aria-label in its icon-only mode (no `label` prop passed) — used exactly that way here,
    // by CodeCommentary for every assistant/user message in the transcript.
    await mockCodeApp(page, { session: SESSION, messages: MESSAGES })
    await page.goto(`/workspace/code/${SESSION.id}`)
    await expect(page.getByText('Done — fixed the off-by-one.')).toBeVisible()
    // Hover-only in CSS (`.hover-actions`) but still present/queryable in the accessibility
    // tree regardless of visual hover state — getByRole doesn't require visibility to match.
    await expect(page.getByRole('button', { name: 'Copy' }).first()).toBeAttached()
  })
})

test.describe('Final gate — real accessible names on the Code launchpad composer', () => {
  test('idle Send and Add-context both have real accessible names', async ({ page }) => {
    await mockCodeApp(page)
    await page.goto('/workspace/code')
    await expect(page.getByPlaceholder(/describe a task/i)).toBeVisible()
    await expect(page.getByRole('button', { name: 'Send' })).toBeAttached()
    await expect(page.getByRole('button', { name: 'Add context' })).toBeVisible()
  })
})
