import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ExposureConfirmDialog } from './ExposureConfirmDialog'

describe('ExposureConfirmDialog', () => {
  it('names the provider and says plainly that the daemon becomes internet-reachable', () => {
    render(<ExposureConfirmDialog provider="cloudflare-quick" open onConfirm={vi.fn()} onCancel={vi.fn()} />)
    expect(screen.getByText(/reachable from the internet/i)).toBeTruthy()
    expect(screen.getByText(/Cloudflare quick tunnel/i)).toBeTruthy()
  })

  it('says an access token will be required', () => {
    render(<ExposureConfirmDialog provider="ngrok" open onConfirm={vi.fn()} onCancel={vi.fn()} />)
    expect(screen.getByText(/access token/i)).toBeTruthy()
  })

  it('confirming calls onConfirm exactly once', async () => {
    const onConfirm = vi.fn()
    render(<ExposureConfirmDialog provider="custom" open onConfirm={onConfirm} onCancel={vi.fn()} />)
    await userEvent.click(screen.getByRole('button', { name: /turn it on/i }))
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })

  it('cancelling calls onCancel and never onConfirm', async () => {
    const onConfirm = vi.fn()
    const onCancel = vi.fn()
    render(<ExposureConfirmDialog provider="custom" open onConfirm={onConfirm} onCancel={onCancel} />)
    await userEvent.click(screen.getByRole('button', { name: /cancel/i }))
    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('confirming calls onConfirm but never onCancel (M3 — AlertDialogAction also closes the dialog)', async () => {
    const onConfirm = vi.fn()
    const onCancel = vi.fn()
    render(<ExposureConfirmDialog provider="custom" open onConfirm={onConfirm} onCancel={onCancel} />)
    await userEvent.click(screen.getByRole('button', { name: /turn it on/i }))
    expect(onConfirm).toHaveBeenCalledTimes(1)
    expect(onCancel).not.toHaveBeenCalled()
  })

  it('renders nothing at all for Tailscale Serve — it is not an internet exposure', () => {
    const { container } = render(
      <ExposureConfirmDialog provider="tailscale-serve" open onConfirm={vi.fn()} onCancel={vi.fn()} />,
    )
    expect(container.textContent).toBe('')
  })
})
