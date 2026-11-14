import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LoadMore } from './LoadMore'

afterEach(() => { vi.unstubAllGlobals() })

describe('LoadMore', () => {
  it('is a button that asks for the next page', async () => {
    const onLoadMore = vi.fn()
    render(<LoadMore label="Load older runs" onLoadMore={onLoadMore} loading={false} />)
    await userEvent.click(screen.getByRole('button', { name: 'Load older runs' }))
    expect(onLoadMore).toHaveBeenCalledOnce()
  })

  it('is disabled and says so while a page is on its way', () => {
    render(<LoadMore label="Load more" onLoadMore={() => {}} loading />)
    const button = screen.getByRole('button', { name: 'Loading…' })
    expect(button).toBeDisabled()
  })

  it('with auto, loads the next page by itself when scrolled into view', () => {
    let reveal: (entries: Array<{ isIntersecting: boolean }>) => void = () => {}
    const disconnect = vi.fn()
    vi.stubGlobal('IntersectionObserver', class {
      constructor(cb: typeof reveal) { reveal = cb }
      observe() {}
      disconnect() { disconnect() }
    })
    const onLoadMore = vi.fn()
    const { unmount } = render(<LoadMore label="Load more" onLoadMore={onLoadMore} loading={false} auto />)
    act(() => reveal([{ isIntersecting: false }]))
    expect(onLoadMore).not.toHaveBeenCalled()
    act(() => reveal([{ isIntersecting: true }]))
    expect(onLoadMore).toHaveBeenCalledOnce()
    unmount()
    expect(disconnect).toHaveBeenCalled()
  })

  it('with auto, does not ask again while the page it asked for is still loading', () => {
    let reveal: (entries: Array<{ isIntersecting: boolean }>) => void = () => {}
    vi.stubGlobal('IntersectionObserver', class {
      constructor(cb: typeof reveal) { reveal = cb }
      observe() {}
      disconnect() {}
    })
    const onLoadMore = vi.fn()
    render(<LoadMore label="Load more" onLoadMore={onLoadMore} loading auto />)
    act(() => reveal([{ isIntersecting: true }]))
    expect(onLoadMore).not.toHaveBeenCalled()
  })

  it('with auto, keeps loading when the button is still in view after a page lands', () => {
    // A real observer reports the button's visibility the moment it starts watching.
    vi.stubGlobal('IntersectionObserver', class {
      constructor(private cb: (entries: Array<{ isIntersecting: boolean }>) => void) {}
      observe() { this.cb([{ isIntersecting: true }]) }
      disconnect() {}
    })
    const onLoadMore = vi.fn()
    const { rerender } = render(<LoadMore label="Load more" onLoadMore={onLoadMore} loading={false} auto />)
    expect(onLoadMore).toHaveBeenCalledTimes(1)
    rerender(<LoadMore label="Load more" onLoadMore={onLoadMore} loading auto />)
    rerender(<LoadMore label="Load more" onLoadMore={onLoadMore} loading={false} auto />)
    expect(onLoadMore).toHaveBeenCalledTimes(2)
  })

  it('with auto, still works as a button where there is no IntersectionObserver', async () => {
    const onLoadMore = vi.fn()
    render(<LoadMore label="Load more" onLoadMore={onLoadMore} loading={false} auto />)
    await userEvent.click(screen.getByRole('button', { name: 'Load more' }))
    expect(onLoadMore).toHaveBeenCalledOnce()
  })
})
