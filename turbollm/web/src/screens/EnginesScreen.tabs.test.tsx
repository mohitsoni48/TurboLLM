// Issue #211 follow-up: EnginesScreen gained a 3-tab shell (Engines / Monitor / Usage) so
// Monitor and Usage no longer need their own top-level nav entries. This covers the SHELL
// itself — default tab, `?tab=` switching (both directions: URL drives the render, clicking a
// tab drives the URL), and the scroll-mode flip ADR-409's whole reason for a bounded Monitor
// still requires. It does NOT re-verify EngineGalleryTab's own internals (Zones 1-4), which
// predate this change and are unaffected by it — MonitorTab and TokensScreen are mocked away
// entirely so this file only exercises the switching logic around them.
import { render, screen, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { EnginesScreen } from './EnginesScreen'
import { useScrollMode } from '../lib/scroll-mode'

vi.mock('./engines/MonitorTab', () => ({ MonitorTab: () => <div data-testid="monitor-tab-mock">Monitor tab content</div> }))
// The mock must still call `useDocumentScroll()`, same as the real TokensScreen does
// unconditionally — that's the one piece of real TokensScreen behavior this file's scroll-mode
// assertions actually depend on; everything else about the component is irrelevant here.
vi.mock('./TokensScreen', async () => {
  const { useDocumentScroll } = await import('../lib/scroll-mode')
  return {
    TokensScreen: () => {
      useDocumentScroll()
      return <div data-testid="usage-tab-mock">Usage tab content</div>
    },
  }
})
vi.mock('../lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/api')>()),
  track: vi.fn(),
}))

/** The real `EngineGalleryTab` (unexported, inside EnginesScreen.tsx) pulls in a wide hook
 *  tree — every hook is left REAL here (no `'../lib/queries'` mock) rather than enumerated,
 *  and a stubbed `fetch` returning an empty 200 for everything lets React Query settle into
 *  the same empty/loading states these screens are already written to render safely (`?? []`
 *  and `isLoading`/`isError` branches throughout) — same reasoning as it not needing a live
 *  daemon in dev. This test only asserts presence/absence of tab content, never Zone
 *  internals, so an empty-data render is sufficient. */
function stubFetch() {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })))
}

/** Real `Shell.tsx` is what actually toggles `tllm-doc-scroll` on `<html>` (already covered by
 *  Shell.test.tsx); this file only needs to know what mode EnginesScreen RESOLVES TO per tab,
 *  which is what `useScrollMode()` reports — read via a tiny sibling probe. */
function ScrollModeProbe() {
  return <div data-testid="scroll-mode">{useScrollMode()}</div>
}

function renderAt(path: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <ScrollModeProbe />
        <EnginesScreen />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  stubFetch()
})

describe('EnginesScreen tabs (issue #211 follow-up)', () => {
  it('defaults to the Engines tab when no ?tab= is present', () => {
    renderAt('/engines')
    expect(screen.getByRole('heading', { name: 'Engines' })).toBeInTheDocument()
    expect(screen.queryByTestId('monitor-tab-mock')).not.toBeInTheDocument()
    expect(screen.queryByTestId('usage-tab-mock')).not.toBeInTheDocument()
  })

  it('?tab=monitor renders MonitorTab and hides the Engines gallery', () => {
    renderAt('/engines?tab=monitor')
    expect(screen.getByTestId('monitor-tab-mock')).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Engines' })).not.toBeInTheDocument()
    expect(screen.queryByTestId('usage-tab-mock')).not.toBeInTheDocument()
  })

  it('?tab=usage renders TokensScreen and hides the Engines gallery', () => {
    renderAt('/engines?tab=usage')
    expect(screen.getByTestId('usage-tab-mock')).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Engines' })).not.toBeInTheDocument()
    expect(screen.queryByTestId('monitor-tab-mock')).not.toBeInTheDocument()
  })

  it('an unrecognized ?tab= value falls back to Engines, not a blank tab', () => {
    renderAt('/engines?tab=nonsense')
    expect(screen.getByRole('heading', { name: 'Engines' })).toBeInTheDocument()
  })

  it('clicking a tab button switches content (Engines → Monitor → Usage)', () => {
    renderAt('/engines')
    expect(screen.getByRole('heading', { name: 'Engines' })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Monitor' }))
    expect(screen.getByTestId('monitor-tab-mock')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Usage' }))
    expect(screen.getByTestId('usage-tab-mock')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Engines' }))
    expect(screen.getByRole('heading', { name: 'Engines' })).toBeInTheDocument()
  })

  // ADR-409's whole reason for Monitor being a BOUNDED split screen rather than a document-
  // scroll page: the log's own auto-scroll and the stats pane's independent scroll must never
  // fight over the page's scroll position. `useDocumentScroll` (lib/scroll-mode.ts) is
  // refcounted and toggles `tllm-doc-scroll` on <html> — this only matters if that toggle
  // survives the tab switch instead of latching on/off.
  it('scroll mode resolves to document on Engines/Usage, and bounded on Monitor', () => {
    // Navigated via a CLICK, not a second `render`/`rerender` with different
    // `initialEntries` — `MemoryRouter` only consults `initialEntries` on its first render, so
    // a rerender with a new value would silently no-op instead of actually navigating.
    renderAt('/engines')
    expect(screen.getByTestId('scroll-mode').textContent).toBe('document')

    fireEvent.click(screen.getByRole('button', { name: 'Monitor' }))
    expect(screen.getByTestId('scroll-mode').textContent).toBe('bounded')

    fireEvent.click(screen.getByRole('button', { name: 'Usage' }))
    expect(screen.getByTestId('scroll-mode').textContent).toBe('document')
  })
})
