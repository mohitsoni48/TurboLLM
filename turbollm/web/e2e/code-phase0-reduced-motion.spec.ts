import { test, expect } from '@playwright/test'
import { mockCodeApp } from './fixtures/code-mocks'

// Final-gate item 5 (docs/specs/16-code-ui-redesign-test-plan.md §9): "Reduced-motion respected
// for every new animation." Follows the same page.emulateMedia() convention
// code-phase0-tokens.spec.ts already uses for prefers-color-scheme — real browser media-query
// emulation, not a matchMedia mock — driving `.tllm-pulse` (the sidebar's live running-indicator
// dot, ADR-256/task #17) through both states and asserting the real computed animation, not just
// that the class name is present.

const SESSION = { id: 's1', title: 'Live session', repoRoot: '/repo', running: true }

test.describe('Phase 0 — reduced motion (spec 16 §9 item 5)', () => {
  test('the sidebar\'s live running-indicator dot (.tllm-pulse) actually animates with no preference, and stops under prefers-reduced-motion: reduce', async ({ page }) => {
    await mockCodeApp(page, { session: SESSION, messages: [] })

    // Baseline: no reduced-motion preference — the dot's infinite pulse must be real, not just
    // present in markup (otherwise the "and stops" half of this test would be vacuous).
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    await page.goto(`/workspace/code/${SESSION.id}`)
    const dot = page.locator('span.tllm-pulse').first()
    await expect(dot).toBeVisible()
    await expect(dot).toHaveCSS('animation-name', 'tllm-pulse')
    await expect(dot).not.toHaveCSS('animation-duration', '0s')

    // Same session, same markup — only the OS-level preference changes. index.css's
    // `@media (prefers-reduced-motion: reduce) { .tllm-pulse { animation: none } }` must kill it.
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.reload()
    const dotAfter = page.locator('span.tllm-pulse').first()
    await expect(dotAfter).toBeVisible()
    await expect(dotAfter).toHaveCSS('animation-name', 'none')
  })
})
