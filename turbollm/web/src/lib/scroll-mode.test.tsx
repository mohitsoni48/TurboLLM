// Issue #178: the long list-style screens hand scrolling back to the window instead of stacking it
// on an inner box. Two halves are pinned here — the refcounted opt-in store, and the CSS lock it
// switches off (a source-string check, same trust level as reduced-motion.test.ts / no-stray-hex).
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ReactNode } from 'react'
import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { useDocumentScroll, useScrollMode } from './scroll-mode'

const CSS = readFileSync(join(import.meta.dirname, '..', 'index.css'), 'utf8')

/** Renders the current mode as text so a test can read it back. */
function Probe() {
  return <span data-testid="mode">{useScrollMode()}</span>
}

function Opt({ enabled = true }: { enabled?: boolean }) {
  useDocumentScroll(enabled)
  return null
}

function renderWith(ui: ReactNode) {
  return render(
    <>
      <Probe />
      {ui}
    </>,
  )
}

describe('scroll-mode store', () => {
  it('is bounded when nothing has opted in', () => {
    const { getByTestId } = renderWith(null)
    expect(getByTestId('mode').textContent).toBe('bounded')
  })

  it('switches to document while a view opts in', () => {
    const { getByTestId } = renderWith(<Opt />)
    expect(getByTestId('mode').textContent).toBe('document')
  })

  it('ignores an opt-in that is disabled (Models Discover tab)', () => {
    const { getByTestId } = renderWith(<Opt enabled={false} />)
    expect(getByTestId('mode').textContent).toBe('bounded')
  })

  it('follows the `enabled` flag flipping, so a tab switch changes mode without remounting', () => {
    const { getByTestId, rerender } = render(
      <>
        <Probe />
        <Opt enabled />
      </>,
    )
    expect(getByTestId('mode').textContent).toBe('document')
    rerender(
      <>
        <Probe />
        <Opt enabled={false} />
      </>,
    )
    expect(getByTestId('mode').textContent).toBe('bounded')
  })

  it('goes back to bounded when the opted-in view unmounts', () => {
    const { getByTestId, rerender } = render(
      <>
        <Probe />
        <Opt />
      </>,
    )
    expect(getByTestId('mode').textContent).toBe('document')
    rerender(
      <>
        <Probe />
      </>,
    )
    expect(getByTestId('mode').textContent).toBe('bounded')
  })

  /** Refcounted, not a boolean: React mounts the incoming screen's effects in the same commit that
   *  tears the outgoing one's down, and StrictMode double-invokes effects in dev. A boolean would
   *  latch off (or on) on either. */
  it('stays in document mode while two views overlap, and only one has unmounted', () => {
    const { getByTestId, rerender } = render(
      <>
        <Probe />
        <Opt />
        <Opt />
      </>,
    )
    expect(getByTestId('mode').textContent).toBe('document')
    rerender(
      <>
        <Probe />
        <Opt />
      </>,
    )
    expect(getByTestId('mode').textContent).toBe('document')
  })
})

describe('index.css scroll lock', () => {
  /** The bounded shell (Chat/Workspace/Code/Discover/routine editor) depends on this rule; only its
   *  SCOPE moved. If the `html:not(.tllm-doc-scroll)` guard is ever dropped, every opted-in screen
   *  silently goes back to being unscrollable at the window level — the exact bug in #178. */
  it('scopes the height/overflow lock to html:not(.tllm-doc-scroll)', () => {
    expect(CSS).toContain('html:not(.tllm-doc-scroll),\nhtml:not(.tllm-doc-scroll) body,\nhtml:not(.tllm-doc-scroll) #root {')
    // …and no unscoped `html, body, #root` lock survives alongside it.
    expect(CSS).not.toMatch(/^html,\r?\nbody,\r?\n#root \{/m)
  })

  it('offsets in-page sticky bars past MobileNav only below md AND while document-scrolling', () => {
    // The invariants, not the block's exact shape: both inset vars are 0 by default, and
    // mobile-nav gains its 3.5rem only inside the md-max media query under document-scrolling.
    expect(CSS).toMatch(/:root\s*\{[^}]*--tllm-mobile-nav-h: 0px;[^}]*\}/)
    expect(CSS).toMatch(/@media \(max-width: 767px\)[\s\S]*?html\.tllm-doc-scroll\s*\{[^}]*--tllm-mobile-nav-h: calc\(3\.5rem \+ env\(safe-area-inset-bottom\)\);/)
    // ADR-383: the hardware bar's own height defaults to 0 and is non-zero ONLY in the same
    // single case (mobile + document-scrolling + bar on) - asserted here so a future edit
    // cannot make the Settings save-bar overlap the bar.
    expect(CSS).toMatch(/:root\s*\{[^}]*--tllm-hw-bar-h: 0px;[^}]*\}/)
    expect(CSS).toMatch(/html\.tllm-doc-scroll\.tllm-hw-bar\s*\{[^}]*--tllm-hw-bar-h: 1\.5rem;/)
  })
})
