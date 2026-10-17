import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { TokensScreen } from './TokensScreen'

const base = {
  sessions: 0, messages: 0, totalTokens: 0, activeDays: 0, currentStreak: 0, longestStreak: 0,
  peakHour: null, favoriteModel: null, firstMessageAt: null, lifetimeTotalTokens: 50000,
  milestone: { achieved: null, next: 100000, progressPct: 50 }, activity: { granularityHours: 24, buckets: [] },
  dailyByModel: [], byModel: [],
}
// An API-only user (no in-app chats): 12 gateway requests overall, none in the last 7 days.
vi.mock('../lib/queries', () => ({
  useTokenUsage: (range: string) => ({
    isLoading: false, isError: false, refetch: () => {},
    data: { ...base, range, api: { range, requests: range === 'all' ? 12 : 0, totalTokens: range === 'all' ? 50000 : 0, lifetimeTotalTokens: 50000, bySource: [], byModel: [] } },
  }),
}))
vi.mock('../lib/api', async (orig) => ({ ...(await orig<typeof import('../lib/api')>()), track: () => {} }))

describe('TokensScreen', () => {
  it('keeps the range picker for an API-only user whose selected range has no traffic', async () => {
    render(<TokensScreen />)
    await userEvent.click(screen.getByRole('button', { name: '7d' }))
    expect(screen.queryByText(/Start a chat to see your token usage here/)).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: 'All' }))
    expect(screen.getByRole('button', { name: '7d' })).toBeTruthy()
  })
})
