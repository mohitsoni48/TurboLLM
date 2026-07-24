import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { describe, expect, it, vi } from 'vitest'
import { ConversationSidebar } from './ConversationSidebar'
import type { CodeSession } from '../../lib/code-types'

// Code mode is gated behind Settings → Experimental (ConversationSidebar.tsx:299) — force it on
// so the sidebar actually renders CodeSessionsList instead of the chat folder/conversation list.
vi.mock('../../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/api')>()
  return {
    ...actual,
    getSettings: vi.fn(async () => ({ experimental: { code: true } }) as ReturnType<typeof actual.getSettings> extends Promise<infer T> ? T : never),
  }
})

const RUNNING_SESSION: CodeSession = {
  id: 's-running',
  convId: 'c-running',
  title: 'Refactor the build pipeline',
  status: 'review',
  branch: 'main',
  when: '2m ago',
  add: 12,
  del: 3,
  createdAt: new Date().toISOString(),
  repoRoot: '/repo/turbollm',
  running: true,
}

const IDLE_SESSION: CodeSession = {
  id: 's-idle',
  convId: 'c-idle',
  title: 'Fix the flaky test',
  status: 'review',
  branch: 'main',
  when: '1h ago',
  add: 4,
  del: 1,
  createdAt: new Date().toISOString(),
  repoRoot: '/repo/turbollm',
  running: false,
}

// listCodeSessions is what useCodeSessions (ConversationSidebar's own CodeSessionsList) polls —
// mocking here is the ADR-256 scenario itself: a session running in the DAEMON background, with
// no locally-open SSE connection driving any client-side "generating" state for it.
vi.mock('../../lib/code-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/code-api')>()
  return {
    ...actual,
    listCodeSessions: vi.fn(async () => ({ sessions: [RUNNING_SESSION, IDLE_SESSION] })),
  }
})

function renderSidebar() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/workspace/code']}>
        <ConversationSidebar activeId={null} onSelect={() => {}} onNew={() => {}} />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

describe('ConversationSidebar — background-running Code sessions (ADR-256)', () => {
  it('shows a live indicator for a session the daemon reports running, even with no tab open on it', async () => {
    renderSidebar()
    // Both sessions share the same underlying "Needs review" DB status (toSessionStatus
    // collapses running/queued to 'review') — only the live `running` flag tells them apart.
    // The running one gets a distinct "Running" label; the idle one keeps the plain status label.
    expect(await screen.findByText(/Running/)).toBeInTheDocument()
    expect(screen.getByText(/Needs review/)).toBeInTheDocument()
  })

  it('keeps the plain status label on a session that is not live, even though it shares the running one\'s DB status', async () => {
    renderSidebar()
    const idleTitle = await screen.findByText('Fix the flaky test')
    const idleRow = idleTitle.closest('[role="button"]')
    expect(idleRow).not.toBeNull()
    expect(idleRow).toHaveTextContent('Needs review')
    expect(idleRow).not.toHaveTextContent('Running')
  })
})
