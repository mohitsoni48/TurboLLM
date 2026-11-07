// The saved-memory list pages like the chat sidebar (the daemon sends the newest 200 facts at a time), so a user
// with more than a page of facts can still reach and delete the older ones.
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MemorySection } from './MemorySection'

const fact = (id: string) => ({ id, factText: `Fact ${id}`, createdAt: new Date().toISOString() })
const fetchNextPage = vi.fn()
const list = { hasNextPage: true, isFetchingNextPage: false }

vi.mock('../../lib/chat-queries', () => ({
  useMemoryFacts: () => ({ data: { facts: [fact('a'), fact('b')] }, isLoading: false, fetchNextPage, ...list }),
  useMemoryFactMutations: () => ({ remove: { mutate: vi.fn(), isPending: false } }),
}))
vi.mock('../../lib/queries', () => ({
  useSettings: () => ({ query: { data: { autoMemoryEnabled: true } }, save: { mutate: vi.fn() } }),
}))

async function open() {
  render(<MemorySection />)
  await userEvent.click(screen.getByRole('button', { name: /Memory/ }))
}

beforeEach(() => {
  fetchNextPage.mockClear()
  list.hasNextPage = true
  list.isFetchingNextPage = false
})

describe('MemorySection paging', () => {
  it('offers Load more under the facts while older ones remain, and loads them on click', async () => {
    await open()
    expect(screen.getByText('Fact a')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Load more' }))
    expect(fetchNextPage).toHaveBeenCalledOnce()
  })

  it('offers nothing once every fact is shown', async () => {
    list.hasNextPage = false
    await open()
    expect(screen.queryByRole('button', { name: /load more/i })).not.toBeInTheDocument()
  })

  it('shows the button as loading while the next page is on its way', async () => {
    list.isFetchingNextPage = true
    await open()
    expect(screen.getByRole('button', { name: 'Loading…' })).toBeDisabled()
  })
})
