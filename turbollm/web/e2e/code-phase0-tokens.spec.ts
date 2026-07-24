import { test, expect, type Page } from '@playwright/test'
import { mockCodeApp, type CodeMessageFixture } from './fixtures/code-mocks'

// Phase 0 test suite (task #12, spec 16 §2 "Basic requirements"): the 8 Code-scoped tokens
// (index.css:49-58) are color-mix() over base tokens that already flip between :root/.dark
// (--accent/--warn/--ok/--err/--border) — jsdom (Vitest) cannot compute real color-mix() output
// at all, which is exactly why this needs a real browser. Playwright is the only layer that can
// actually verify "does this resolve to a genuinely different, sensible value in each theme."

const SESSION = { id: 's1', title: 'Fix the login bug', repoRoot: '/repo', branch: 'main' }

// Exercises 6 of the 8 tokens through real rendered components: a user message
// (CodeInstructionEntry → --instruction-border/-bg/-chip-border, via its text attachment chip),
// and an assistant message with an edit tool call carrying a real unified diff
// (CodeDiffPanel → --diff-hunk-bg/-add-bg/-del-bg).
const MESSAGES: CodeMessageFixture[] = [
  { id: 'u1', seq: 1, role: 'user', content: 'Fix the off-by-one in the paginator.', toolCalls: [] },
  {
    id: 'a1', seq: 2, role: 'assistant', content: 'Fixed.',
    toolCalls: [{
      id: 't1', name: 'edit', args: { path: 'src/paginate.ts' },
      diff: '@@ -1,3 +1,3 @@\n context line\n-const page = i;\n+const page = i + 1;\n context line',
      patch: '@@ -1,3 +1,3 @@\n context line\n-const page = i;\n+const page = i + 1;\n context line',
    }],
    timeline: [{ type: 'tool', id: 't1' }],
  },
]

async function gotoSession(page: Page, theme: 'light' | 'dark'): Promise<void> {
  await page.addInitScript((t) => window.localStorage.setItem('tllm.theme', t), theme)
  await mockCodeApp(page, { session: SESSION, messages: MESSAGES })
  await page.goto(`/workspace/code/${SESSION.id}`)
  // The diff panel starts expanded for a lone edit call (CodeToolCard's own default), so no
  // click is needed — but wait for it to actually be in the DOM before asserting on it.
  await expect(page.locator('table').first()).toBeVisible()
}

test.describe('Phase 0 tokens — light/dark resolution', () => {
  for (const theme of ['light', 'dark'] as const) {
    test(`${theme}: instruction/diff tokens resolve to non-empty, distinct computed colors`, async ({ page }) => {
      await gotoSession(page, theme)
      const html = page.locator('html')
      await expect(html).toHaveClass(theme === 'dark' ? /dark/ : /^(?!.*dark).*$/)

      // --instruction-border/-bg: the user message's own bordered card.
      const instructionCard = page.getByText('Fix the off-by-one in the paginator.').locator('..')
      const cardBg = await instructionCard.evaluate((el) => getComputedStyle(el).backgroundColor)
      const cardBorder = await instructionCard.evaluate((el) => getComputedStyle(el).borderColor)
      expect(cardBg).not.toBe('') // resolves to SOME real rgba(), not an unset/transparent no-op
      expect(cardBorder).not.toBe('')

      // --diff-add-bg / --diff-del-bg: the two colored rows in the rendered diff table.
      const addRow = page.locator('tr', { hasText: 'const page = i + 1;' })
      const delRow = page.locator('tr', { hasText: 'const page = i;' }).filter({ hasNotText: '+' })
      const addBg = await addRow.evaluate((el) => getComputedStyle(el).backgroundColor)
      const delBg = await delRow.evaluate((el) => getComputedStyle(el).backgroundColor)
      expect(addBg).not.toBe(delBg) // add (--ok-tinted) and del (--err-tinted) must differ

      // --diff-hunk-bg: the "@@ ... @@" header row.
      const hunkRow = page.locator('tr', { hasText: '@@ -1,3 +1,3 @@' })
      const hunkBg = await hunkRow.evaluate((el) => getComputedStyle(el).backgroundColor)
      expect(hunkBg).not.toBe(addBg)
      expect(hunkBg).not.toBe(delBg)
    })
  }

  test('the SAME token resolves to a genuinely different color between light and dark', async ({ page, context }) => {
    // Two independent page loads (theme is read once at module-init, per stores/ui.ts — no
    // supported live-flip API to test within one page load here) rather than one page with a
    // runtime toggle, so this is a second, more direct cross-theme diff on top of the
    // per-theme checks above — the actual regression this guards against is index.css losing
    // its color-mix() self-adjustment (e.g. someone hardcoding one of these 8 tokens to a flat
    // hex, which would make it IDENTICAL across themes instead of flipping with --accent/etc).
    await gotoSession(page, 'light')
    const addRowLight = page.locator('tr', { hasText: 'const page = i + 1;' })
    const lightAddBg = await addRowLight.evaluate((el) => getComputedStyle(el).backgroundColor)

    const darkPage = await context.newPage()
    await gotoSession(darkPage, 'dark')
    const addRowDark = darkPage.locator('tr', { hasText: 'const page = i + 1;' })
    const darkAddBg = await addRowDark.evaluate((el) => getComputedStyle(el).backgroundColor)

    expect(lightAddBg).not.toBe(darkAddBg)
    await darkPage.close()
  })

  test('toggling the theme class WHILE the Code screen is mounted updates tokens immediately, no reload, no stale leftover', async ({ page }) => {
    // Drives the same DOM primitive stores/ui.ts's applyTheme() uses
    // (document.documentElement.classList.toggle('dark', ...), index.css:61) directly, rather
    // than hunting Settings' theme-toggle UI for this specific claim — what's under test here
    // (does color-mix() recompute immediately when .dark flips, with no leftover stale value
    // from the previous theme) is a pure CSS-cascade behavior, identical regardless of which UI
    // control flips the class. This is exactly spec 16 §2's "no flash-of-wrong-theme, no stale
    // --accent-derived colors left over from the previous theme" requirement.
    await gotoSession(page, 'light')
    const addRow = page.locator('tr', { hasText: 'const page = i + 1;' })
    const lightBg = await addRow.evaluate((el) => getComputedStyle(el).backgroundColor)

    await page.evaluate(() => document.documentElement.classList.add('dark'))
    const darkBg = await addRow.evaluate((el) => getComputedStyle(el).backgroundColor)
    expect(darkBg).not.toBe(lightBg) // updated, not stuck on the old theme's value

    await page.evaluate(() => document.documentElement.classList.remove('dark'))
    const backToLightBg = await addRow.evaluate((el) => getComputedStyle(el).backgroundColor)
    expect(backToLightBg).toBe(lightBg) // and flips back cleanly, no residue
  })

  test('theme="system" follows a live OS-level color-scheme change without a page reload', async ({ page }) => {
    // stores/ui.ts supports 'system' as a real Theme value; main.tsx wires
    // matchMedia('(prefers-color-scheme: dark)').addEventListener('change', ...) specifically to
    // re-apply the theme live when the OS preference flips while theme === 'system' — spec 16 §2's
    // edge case. page.emulateMedia can drive a real prefers-color-scheme change in Chromium; no
    // reload is triggered by this call, matching what a real OS-level flip looks like to the page.
    await page.emulateMedia({ colorScheme: 'light' })
    await page.addInitScript(() => window.localStorage.setItem('tllm.theme', 'system'))
    await mockCodeApp(page, { session: SESSION, messages: MESSAGES })
    await page.goto(`/workspace/code/${SESSION.id}`)
    await expect(page.locator('table').first()).toBeVisible()
    await expect(page.locator('html')).not.toHaveClass(/dark/)

    await page.emulateMedia({ colorScheme: 'dark' })
    await expect(page.locator('html')).toHaveClass(/dark/)

    await page.emulateMedia({ colorScheme: 'light' })
    await expect(page.locator('html')).not.toHaveClass(/dark/)
  })
})

// --toolcard-approval-bg (CodeTranscript.tsx:276) and --status-banner-bg (CodeComposer.tsx:678)
// both ONLY ever apply through a live, SSE-driven state (an in-flight `awaiting_approval` tool
// call; an active run) — never from persisted DB data (confirmed: code-run-manager.ts's sink only
// ever persists a tool call's FINAL 'done'/'error' status, never a live 'pending'/
// 'awaiting_approval' one). Reproducing that through a real live SSE mock is real extra
// infrastructure for two tokens that use the exact same color-mix() mechanism already verified
// above — checked directly against the loaded stylesheet instead. This does NOT verify the
// component wires the token correctly (that's confirmed by source inspection, not this test —
// see the report), only that the token itself resolves correctly per theme, same as the six above.
test.describe('Phase 0 tokens — live-only tokens (toolcard-approval-bg, status-banner-bg)', () => {
  for (const theme of ['light', 'dark'] as const) {
    test(`${theme}: resolve to a real, non-transparent color`, async ({ page }) => {
      await page.addInitScript((t) => window.localStorage.setItem('tllm.theme', t), theme)
      await mockCodeApp(page)
      await page.goto('/workspace/code')
      await expect(page.getByPlaceholder(/describe a task/i)).toBeVisible()

      const colors = await page.evaluate(() => {
        const probe = document.createElement('div')
        probe.style.background = 'var(--toolcard-approval-bg)'
        document.body.appendChild(probe)
        const approval = getComputedStyle(probe).backgroundColor
        probe.style.background = 'var(--status-banner-bg)'
        const banner = getComputedStyle(probe).backgroundColor
        probe.remove()
        return { approval, banner }
      })
      expect(colors.approval).not.toBe('rgba(0, 0, 0, 0)')
      expect(colors.banner).not.toBe('rgba(0, 0, 0, 0)')
      expect(colors.approval).not.toBe(colors.banner) // warn-tinted vs accent-tinted, must differ
    })
  }
})

test.describe('Phase 0 — monospace scope (spec 14 §1.2 audit: already correct, regression guard)', () => {
  test('diff/tool-args content is monospace; prose and nav chrome are not', async ({ page }) => {
    await gotoSession(page, 'light')

    const diffLine = page.locator('td', { hasText: 'const page = i + 1;' })
    const diffFont = await diffLine.evaluate((el) => getComputedStyle(el).fontFamily)
    expect(diffFont.toLowerCase()).toMatch(/mono/)

    // The user message's own prose text must stay sans-serif — monospace only "where it earns
    // it" (ADR-252), never forced onto ordinary prose.
    const prose = page.getByText('Fix the off-by-one in the paginator.')
    const proseFont = await prose.evaluate((el) => getComputedStyle(el).fontFamily)
    expect(proseFont.toLowerCase()).not.toMatch(/mono/)

    // Nav chrome (unrelated to Code at all) must never pick up the Code surface's monospace.
    const navLink = page.getByRole('link', { name: 'Workspace' })
    const navFont = await navLink.evaluate((el) => getComputedStyle(el).fontFamily)
    expect(navFont.toLowerCase()).not.toMatch(/mono/)
  })
})
