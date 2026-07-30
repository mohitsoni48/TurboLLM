import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TelemetryConsentCard } from './TelemetryConsentCard'
import type { DaemonSettings } from '../lib/api'

// jsdom's environment doesn't wire up a working localStorage (authHeaders() reads
// it on every request), same gap as the other component test suites.
beforeEach(() => {
  const store = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v) },
    removeItem: (k: string) => { store.delete(k) },
    clear: () => store.clear(),
  })
})

const getSettings = vi.fn()
const saveSettings = vi.fn()

vi.mock('../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/api')>()
  return {
    ...actual,
    getSettings: (...args: unknown[]) => getSettings(...args),
    saveSettings: (...args: unknown[]) => saveSettings(...args),
  }
})

vi.mock('../lib/flags', () => ({ TELEMETRY_UI_ENABLED: true }))

function undecidedSettings(): Partial<DaemonSettings> {
  return { telemetryLevel: 'off', telemetryDecided: false }
}

function renderCard() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <TelemetryConsentCard />
    </QueryClientProvider>,
  )
}

describe('TelemetryConsentCard', () => {
  it('surfaces an error message when the save fails, so a broken save is never silent', async () => {
    // Found in pre-release review: a failed PUT /api/v1/settings (read-only
    // config, a validation error on an unrelated field, a 401 on LAN) left the
    // Confirm button re-enabled with zero explanation — every upgrading install
    // hits this card via the v3->v4 migration, so a broken save here is a
    // silent, total lockout with no visible cause.
    getSettings.mockResolvedValue(undecidedSettings())
    saveSettings.mockRejectedValue(new Error('That folder does not exist.'))

    renderCard()
    await waitFor(() => expect(screen.getByText('Help improve TurboLLM?')).toBeTruthy())

    const user = userEvent.setup()
    await user.click(screen.getByText('Share anonymous usage + benchmarks'))
    await user.click(screen.getByRole('button', { name: 'Confirm' }))

    await waitFor(() => expect(screen.getByText(/That folder does not exist\./)).toBeTruthy())
  })

  it('leaves the Confirm button enabled after a failed save, so retrying is possible', async () => {
    // The review's actual concern: the button must not stay permanently
    // disabled after an error — that would be a real, unrecoverable lockout,
    // distinct from (and worse than) the by-design "must choose" requirement.
    getSettings.mockResolvedValue(undecidedSettings())
    saveSettings.mockRejectedValue(new Error('network error'))

    renderCard()
    await waitFor(() => expect(screen.getByText('Help improve TurboLLM?')).toBeTruthy())

    const user = userEvent.setup()
    await user.click(screen.getByText('Share anonymous usage + benchmarks'))
    await user.click(screen.getByRole('button', { name: 'Confirm' }))
    await waitFor(() => expect(screen.getByText(/network error/)).toBeTruthy())

    const confirmButton = screen.getByRole('button', { name: 'Confirm' }) as HTMLButtonElement
    expect(confirmButton.disabled).toBe(false)
  })
})
