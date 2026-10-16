import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { CustomizeScreen } from './CustomizeScreen'

const updateMutate = vi.fn()
const mut = () => ({ mutate: vi.fn(), isPending: false })
const filesServer = { id: 'fs', name: 'Files', transport: 'stdio', command: 'npx', args: ['/bad/path'], env: { LEAKED: 'secret' }, enabled: true }
let mcpServers: object[] = [filesServer]
vi.mock('../lib/queries', () => ({
  useSettings: () => ({
    query: {
      data: {
        mcp: { servers: mcpServers },
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

describe('CustomizeScreen — MCP server edit, saved Bearer key', () => {
  // The settings payload never carries the key, only apiKeySet. The field used to open blank with
  // no sign a key was stored, and no edit could ever send the '' that removes it.
  beforeEach(() => {
    mcpServers = [{ id: 'gh', name: 'GitHub', transport: 'sse', url: 'https://mcp.one.example/sse', apiKeySet: true, enabled: true }]
    updateMutate.mockClear()
  })

  const openEdit = async () => {
    render(<MemoryRouter initialEntries={['/customize?tab=mcp']}><CustomizeScreen /></MemoryRouter>)
    await userEvent.click(screen.getByRole('button', { name: /Connected/ }))
    await userEvent.click(screen.getByTitle('Edit'))
  }

  it('shows that a key is saved, and a blank field keeps it', async () => {
    await openEdit()
    expect(screen.getByPlaceholderText('Key set — leave blank to keep')).toHaveValue('')
    await userEvent.click(screen.getByRole('button', { name: 'Update' }))
    expect(updateMutate).toHaveBeenCalledTimes(1)
    expect(updateMutate.mock.calls[0][0].patch.apiKey).toBeUndefined()
  })

  it("Clear key sends apiKey '', which removes the saved key", async () => {
    await openEdit()
    await userEvent.click(screen.getByRole('button', { name: 'Clear key' }))
    expect(screen.getByText('The saved key is removed on Update.')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Update' }))
    expect(updateMutate).toHaveBeenCalledTimes(1)
    expect(updateMutate.mock.calls[0][0].patch.apiKey).toBe('')
  })
})
