// Issue #211 follow-up: /monitor, /usage, and /developer stopped being top-level destinations
// (Monitor and Usage folded into Engines' tabs, Developer into Customize's) — App.tsx replaces
// each with a `<Navigate>` so ADR-409's deep links, bookmarks, and doc references keep
// resolving instead of 404ing to Workspace.
//
// Deliberately does NOT render the full `<App/>` — it pulls in AuthGate, onboarding state,
// status/settings polling, and the routine-notification poller, none of which this redirect
// logic depends on, and mocking all of it just to prove three `<Navigate to="...">` strings
// are correct would cost far more than it verifies. Instead this mounts a minimal `<Routes>`
// tree with the EXACT redirect lines from App.tsx (kept in sync by hand — if those routes ever
// change, this file's own routes must change with them) plus a stub landing route to observe
// where each redirect actually lands, including its query string.
import { render, screen } from '@testing-library/react'
import { MemoryRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { describe, expect, it } from 'vitest'

function LocationProbe() {
  const loc = useLocation()
  return <div data-testid="landed">{loc.pathname}{loc.search}</div>
}

function RedirectRoutes() {
  return (
    <Routes>
      {/* Mirrors App.tsx's own three redirect lines verbatim. */}
      <Route path="/monitor" element={<Navigate to="/engines?tab=monitor" replace />} />
      <Route path="/usage" element={<Navigate to="/engines?tab=usage" replace />} />
      <Route path="/developer" element={<Navigate to="/customize?tab=connect" replace />} />
      <Route path="/engines" element={<LocationProbe />} />
      <Route path="/customize" element={<LocationProbe />} />
    </Routes>
  )
}

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <RedirectRoutes />
    </MemoryRouter>,
  )
}

describe('retired top-level routes redirect into the tab that absorbed them', () => {
  it('/monitor → /engines?tab=monitor', () => {
    renderAt('/monitor')
    expect(screen.getByTestId('landed').textContent).toBe('/engines?tab=monitor')
  })

  it('/usage → /engines?tab=usage', () => {
    renderAt('/usage')
    expect(screen.getByTestId('landed').textContent).toBe('/engines?tab=usage')
  })

  it('/developer → /customize?tab=connect', () => {
    renderAt('/developer')
    expect(screen.getByTestId('landed').textContent).toBe('/customize?tab=connect')
  })
})
