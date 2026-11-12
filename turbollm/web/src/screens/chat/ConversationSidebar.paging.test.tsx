// The chat sidebar pages its conversation list (the daemon sends 200 at a time). Older chats stay reachable by
// scrolling or by the "Load more" button under the list; a search is answered in full and never shows it.
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ConversationSidebar } from './ConversationSidebar'

const conv = (id: string) => ({
  id, title: `Chat ${id}`, systemPrompt: '', modelKey: 'm1', sampling: {}, expertMode: false,
  preserveThinking: true, updatedAt: new Date().toISOString(), createdAt: new Date().toISOString(), folderId: null,
})

const fetchNextPage = vi.fn()
const list = { hasNextPage: true, isFetchingNextPage: false }
const searchedWith: Array<string | undefined> = []

vi.mock('../../lib/chat-queries', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/chat-queries')>()),
  useConversations: (q?: string) => {
    searchedWith.push(q)
    return { data: { conversations: [conv('a'), conv('b')] }, fetchNextPage, ...list }
  },
  useFolders: () => ({ data: { folders: [] } }),
}))

function renderSidebar() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/workspace/chat']}>
        <ConversationSidebar activeId={null} onSelect={() => {}} onNew={() => {}} collapsed={false} />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  fetchNextPage.mockClear()
  searchedWith.length = 0
  list.hasNextPage = true
  list.isFetchingNextPage = false
})

describe('ConversationSidebar paging', () => {
  it('offers Load more under the list while the daemon has older conversations, and loads them on click', async () => {
    renderSidebar()
    await userEvent.click(screen.getByRole('button', { name: 'Load more' }))
    expect(fetchNextPage).toHaveBeenCalledOnce()
  })

  it('shows no Load more once the last page is in', () => {
    list.hasNextPage = false
    renderSidebar()
    expect(screen.queryByRole('button', { name: /load more/i })).toBeNull()
  })

  it('shows the button as loading while the next page is on its way', () => {
    list.isFetchingNextPage = true
    renderSidebar()
    expect(screen.getByRole('button', { name: 'Loading…' })).toBeDisabled()
  })

  it('does not offer Load more on search results, which are never paged', async () => {
    renderSidebar()
    await userEvent.type(screen.getByRole('textbox'), 'cats')
    await vi.waitFor(() => expect(searchedWith).toContain('cats'))
    expect(screen.queryByRole('button', { name: /load more/i })).toBeNull()
  })
})
