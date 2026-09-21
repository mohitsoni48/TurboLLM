// The response panel (ADR-439): the raw response, or the exact request that produced it as a
// command to paste. Switching tabs never re-runs anything and is not a telemetry event.
// The curl is the screenshot people share, so the stored auth key must appear nowhere in it.
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { buildCurl } from '../../lib/jev-api'
import type { SystemOneRequest } from '../../lib/systemone-types'
import { ResponsePanel, type SystemOneRun } from './ResponsePanel'

const h = vi.hoisted(() => ({ track: vi.fn(), writeText: vi.fn() }))

vi.mock('../../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/api')>()
  return { ...actual, track: (...a: unknown[]) => h.track(...a) }
})

const LOOPBACK = 'http://localhost:6996'
const LAN = 'http://192.168.1.5:6996'
const AUTH_KEY = 'tllm.authToken'

const REQUEST: SystemOneRequest = {
  state: 'The printer on floor 3 is on fire.',
  model: 'qwen3.5 4b nli v2|mlx-fp16|9012345678',
  questions: { urgent: { type: 'noul', instructions: 'Is this urgent?' } },
}

const RUN: SystemOneRun = {
  request: REQUEST,
  response: {
    model: REQUEST.model,
    answers: { urgent: { type: 'noul', noul: 0.945 } },
    usage: { input_tokens: 42, output_tokens: 1 },
  },
  ms: 123,
}

const EXPECTED_CURL = buildCurl(LOOPBACK, 'systemone', REQUEST)

function renderPanel(run: SystemOneRun | null = RUN, origin = LOOPBACK) {
  return render(<ResponsePanel run={run} origin={origin} />)
}

async function showCurl() {
  await userEvent.click(screen.getByRole('button', { name: 'curl' }))
}

beforeEach(() => {
  h.track.mockReset()
  h.writeText.mockReset().mockResolvedValue(undefined)
  Object.defineProperty(navigator, 'clipboard', { value: { writeText: h.writeText }, configurable: true })
  localStorage.clear()
})

describe('ResponsePanel', () => {
  it('asks for a run before it has one, and shows no footer', () => {
    renderPanel(null)
    expect(screen.getByText('Run to see the response and the request as curl.')).toBeTruthy()
    expect(screen.queryByText(/input tokens/)).toBeNull()
  })

  it('shows the response exactly as it arrived, pretty-printed, by default', () => {
    const { container } = renderPanel()
    const shown = container.querySelector('pre')?.textContent
    expect(shown).toBe(JSON.stringify(RUN.response, null, 2))
    expect(shown).toContain('"answers"')
  })

  it('shows the request that ran as a runnable command on the curl tab', async () => {
    const { container } = renderPanel()
    await showCurl()
    expect(container.querySelector('pre')?.textContent).toBe(EXPECTED_CURL)
  })

  it('copies that exact command from the curl tab, and records the copy as its own action', async () => {
    renderPanel()
    await showCurl()
    await userEvent.click(screen.getByRole('button', { name: 'Copy' }))
    expect(h.writeText).toHaveBeenCalledWith(EXPECTED_CURL)
    expect(h.track).toHaveBeenCalledWith('workspace', 'jev_copy_request')
  })

  it('offers no copy button on the response tab', () => {
    renderPanel()
    expect(screen.queryByRole('button', { name: 'Copy' })).toBeNull()
  })

  it('says how long the run took and how many tokens went in', () => {
    renderPanel()
    expect(screen.getByText('123 ms · 42 input tokens')).toBeTruthy()
  })

  it('leads the curl with the auth hint from a LAN origin, and never shows the stored key anywhere', async () => {
    localStorage.setItem(AUTH_KEY, 'secret-key')
    expect(localStorage.getItem(AUTH_KEY)).toBe('secret-key')
    const { container } = renderPanel(RUN, LAN)
    await showCurl()
    expect(container.querySelector('pre')?.textContent?.startsWith('# add -H "X-TurboLLM-Auth: <your key>"\n')).toBe(true)
    expect(document.body.innerHTML).not.toContain('secret-key')
  })

  it('offers the two views as a pressed-state toggle, response first', async () => {
    renderPanel()
    const group = screen.getByRole('group', { name: 'Response view' })
    const response = screen.getByRole('button', { name: 'Response' })
    const curl = screen.getByRole('button', { name: 'curl' })
    expect(group.contains(response) && group.contains(curl)).toBe(true)
    expect(response.getAttribute('aria-pressed')).toBe('true')
    expect(curl.getAttribute('aria-pressed')).toBe('false')

    await userEvent.click(curl)
    expect(curl.getAttribute('aria-pressed')).toBe('true')
    expect(response.getAttribute('aria-pressed')).toBe('false')

    await userEvent.click(response)
    expect(response.getAttribute('aria-pressed')).toBe('true')
  })

  it('does not record a telemetry event for switching tabs', async () => {
    renderPanel()
    await showCurl()
    await userEvent.click(screen.getByRole('button', { name: 'Response' }))
    expect(h.track).not.toHaveBeenCalled()
  })

  it('scrolls the curl sideways instead of wrapping it mid-token', async () => {
    const { container } = renderPanel()
    await showCurl()
    const classes = container.querySelector('pre')?.classList
    expect(classes?.contains('overflow-x-auto')).toBe(true)
    expect(classes?.contains('whitespace-pre')).toBe(true)
    expect(classes?.contains('whitespace-pre-wrap')).toBe(false)
    expect(classes?.contains('break-all')).toBe(false)
  })
})
