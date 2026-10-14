import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { CustomizeScreen } from './CustomizeScreen'

const updateMutate = vi.fn()
const mut = () => ({ mutate: vi.fn(), isPending: false })
vi.mock('../lib/queries', () => ({
  useSettings: () => ({
    query: {
      data: {
        mcp: { servers: [{ id: 'fs', name: 'Files', transport: 'stdio', command: 'npx', args: ['/bad/path'], env: { LEAKED: 'secret' }, enabled: true }] },
        search: { provider: 'tavily', tavilyKeySet: false, kagiKeySet: false, searxngUrl: '' },
      },
    },
    save: mut(),
  }),
  useSysInfo: () => ({ data: undefined }),
  useMcpMutations: () => ({ add: mut(), update: { mutate: updateMutate, isPending: false }, remove: mut(), toggle: mut() }),
}))
vi.mock('../lib/api', async (orig) => ({ ...(await orig<typeof import('../lib/api')>()), track: () => {} }))

describe('CustomizeScreen — MCP server edit', () => {
  it('sends an emptied args list and env map, so the last arg / env var can actually be removed', async () => {
    render(<MemoryRouter initialEntries={['/customize?tab=mcp']}><CustomizeScreen /></MemoryRouter>)
    await userEvent.click(screen.getByRole('button', { name: /Connected/ }))
    await userEvent.click(screen.getByTitle('Edit'))
    await userEvent.clear(screen.getByDisplayValue('/bad/path'))
    await userEvent.clear(screen.getByDisplayValue('LEAKED=secret'))
    await userEvent.click(screen.getByRole('button', { name: 'Update' }))
    expect(updateMutate).toHaveBeenCalledTimes(1)
    const { patch } = updateMutate.mock.calls[0][0]
    // The PUT route only assigns args/env when present — undefined (dropped from JSON) kept the old ones.
    expect(patch.args).toEqual([])
    expect(patch.env).toEqual({})
  })
})
