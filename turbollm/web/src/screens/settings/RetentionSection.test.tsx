// Settings → System → Data retention: an on/off toggle and two bounded numbers, each saved on its own.
// The bounds and error messages mirror the daemon's RETENTION_BOUNDS (config-bounds.ts), so a value the
// page lets through is one the daemon takes, and a value it refuses reads the same on both sides.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { RetentionSection } from './RetentionSection'

const save = { mutate: vi.fn(), isPending: false }
const settings: { retention?: { enabled: boolean; apiUsageRawDays: number; routineRunsKept: number } } = {}

vi.mock('../../lib/queries', () => ({
  useSettings: () => ({ query: { data: settings }, save }),
}))

const DAYS_MESSAGE = 'retention.apiUsageRawDays must be a whole number of days, 31–3650.'
const RUNS_MESSAGE = 'retention.routineRunsKept must be a whole number, 10–100000.'

beforeEach(() => {
  save.mutate.mockClear()
  settings.retention = { enabled: true, apiUsageRawDays: 90, routineRunsKept: 200 }
})

async function typeInto(label: RegExp, text: string) {
  const input = screen.getByLabelText(label) as HTMLInputElement
  await userEvent.clear(input)
  await userEvent.type(input, text)
  await userEvent.tab()
  return input
}

describe('RetentionSection', () => {
  it('renders nothing until the daemon reports retention', () => {
    settings.retention = undefined
    const { container } = render(<RetentionSection />)
    expect(container.firstChild).toBeNull()
  })

  it('shows the stored values, the bounds, and what gets deleted', () => {
    render(<RetentionSection />)
    expect((screen.getByLabelText(/raw API usage/i) as HTMLInputElement).value).toBe('90')
    expect((screen.getByLabelText(/runs per routine/i) as HTMLInputElement).value).toBe('200')
    expect(screen.getByText('31–3650')).toBeTruthy()
    expect(screen.getByText('10–100000')).toBeTruthy()
    expect(screen.getByText(/dashboards keep their totals/i)).toBeTruthy()
    expect(screen.getByText(/never touched/i)).toBeTruthy()
  })

  it('patches only the toggle when it is switched off, and then locks the numbers', async () => {
    const { rerender } = render(<RetentionSection />)
    await userEvent.click(screen.getByRole('checkbox'))
    expect(save.mutate.mock.calls[0][0]).toEqual({ retention: { enabled: false } })

    settings.retention = { enabled: false, apiUsageRawDays: 90, routineRunsKept: 200 }
    rerender(<RetentionSection />)
    expect((screen.getByLabelText(/raw API usage/i) as HTMLInputElement).disabled).toBe(true)
    expect((screen.getByLabelText(/runs per routine/i) as HTMLInputElement).disabled).toBe(true)
  })

  it('patches only the field that changed, once it is committed', async () => {
    render(<RetentionSection />)
    await typeInto(/raw API usage/i, '365')
    expect(save.mutate).toHaveBeenCalledTimes(1)
    expect(save.mutate.mock.calls[0][0]).toEqual({ retention: { apiUsageRawDays: 365 } })

    await typeInto(/runs per routine/i, '50')
    expect(save.mutate.mock.calls[1][0]).toEqual({ retention: { routineRunsKept: 50 } })
  })

  it('does not save an unchanged value', async () => {
    render(<RetentionSection />)
    await typeInto(/raw API usage/i, '90')
    expect(save.mutate).not.toHaveBeenCalled()
  })

  it.each([
    ['30', DAYS_MESSAGE],
    ['3651', DAYS_MESSAGE],
    ['45.5', DAYS_MESSAGE],
    ['', DAYS_MESSAGE],
  ])('refuses %j for the usage days with the daemon message, and saves nothing', async (text, message) => {
    render(<RetentionSection />)
    const input = screen.getByLabelText(/raw API usage/i) as HTMLInputElement
    await userEvent.clear(input)
    if (text) await userEvent.type(input, text)
    await userEvent.tab()
    expect(screen.getByRole('alert').textContent).toBe(message)
    expect(save.mutate).not.toHaveBeenCalled()
  })

  it.each(['9', '100001', '12.5'])('refuses %j for the kept runs with the daemon message, and saves nothing', async (text) => {
    render(<RetentionSection />)
    await typeInto(/runs per routine/i, text)
    expect(screen.getByRole('alert').textContent).toBe(RUNS_MESSAGE)
    expect(save.mutate).not.toHaveBeenCalled()
  })

  it('accepts the bounds themselves', async () => {
    render(<RetentionSection />)
    await typeInto(/raw API usage/i, '31')
    await typeInto(/runs per routine/i, '100000')
    expect(save.mutate.mock.calls.map((c) => c[0])).toEqual([
      { retention: { apiUsageRawDays: 31 } },
      { retention: { routineRunsKept: 100000 } },
    ])
  })

  it('clears the error once a valid value is committed', async () => {
    render(<RetentionSection />)
    await typeInto(/raw API usage/i, '5')
    expect(screen.getByRole('alert')).toBeTruthy()
    await typeInto(/raw API usage/i, '60')
    expect(screen.queryByRole('alert')).toBeNull()
  })
})
