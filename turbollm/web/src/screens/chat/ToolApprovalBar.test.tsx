// The approval bar (GitHub #52): run_python shows its whole code and offers Allow once only, as every run asks first;
// other tools keep their four answers.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ToolApprovalBar } from './ToolApprovalBar'

const respond = vi.fn(async () => {})
vi.mock('../../lib/chat-api', () => ({ respondToolApproval: (...a: unknown[]) => respond(...(a as [])) }))
vi.mock('../../lib/api', () => ({ track: () => {}, ApiError: class extends Error {} }))

beforeEach(() => respond.mockClear())

const code = 'import pandas as pd\ndf = pd.read_csv("sales.csv")\nprint(df.sales.sum())'

describe('ToolApprovalBar', () => {
  it('run_python: the whole code, and Deny or Allow once only', async () => {
    render(<ToolApprovalBar convId="c1" onResolved={() => {}} pending={{ id: 't1', name: 'run_python', args: { code }, status: 'awaiting_approval' }} />)
    expect(screen.getByText((_, el) => el?.tagName === 'PRE' && el.textContent === code)).toBeTruthy()
    expect(screen.getByText(/no network and no access to your files/)).toBeTruthy()
    expect(screen.queryByText('Allow for this chat')).toBeNull()
    expect(screen.queryByText('Always Allow')).toBeNull()
    await userEvent.click(screen.getByText('Allow once'))
    expect(respond).toHaveBeenCalledWith('c1', 't1', 'run_python', 'allow')
  })

  it('other tools keep Allow, Allow for this chat and Always Allow', () => {
    render(<ToolApprovalBar convId="c1" onResolved={() => {}} pending={{ id: 't2', name: 'fetch_url', args: { url: 'https://example.com' }, status: 'awaiting_approval' }} />)
    expect(screen.getByText('Allow')).toBeTruthy()
    expect(screen.getByText('Allow for this chat')).toBeTruthy()
    expect(screen.getByText('Always Allow')).toBeTruthy()
    expect(screen.queryByText('Allow once')).toBeNull()
  })
})
