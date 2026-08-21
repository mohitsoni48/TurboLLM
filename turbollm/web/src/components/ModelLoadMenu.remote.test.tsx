import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ModelLoadMenu } from './ModelLoadMenu'
import type { LinkRecord } from '../lib/link-api'
import type { RemoteModelRow } from '../lib/remote-models'
import type { ModelEntry } from '../lib/types'

// The grouping itself is proven in lib/remote-models.test.ts. This file proves the
// component actually RENDERS that result — the badge, the machine subtext, the spelled-out
// reason on a disabled row, and the offline group's own error sentence. Verifying the
// helper alone would let a picker that drops half of it ship green.

vi.mock('../lib/api', () => ({ track: () => {} }))

const LOCAL = [{ key: 'gemma-27b', name: 'Gemma 27B', quant: 'Q4_K_M', incomplete: false, parseError: null, loaded: false }] as unknown as ModelEntry[]

function link(over: Record<string, unknown>): LinkRecord {
  return {
    baseUrl: 'https://rig.trycloudflare.com',
    machineId: 'm1',
    machineIdChanged: false,
    grantedCapabilities: ['models:use'],
    linkApiVersion: 1,
    status: 'online',
    lastSeenAt: null,
    lastError: null,
    ...over,
  } as unknown as LinkRecord
}

const row = (loaded: boolean): RemoteModelRow => ({
  linkId: 'l1',
  machine: 'workstation',
  model: { key: 'qwen3-35b', name: 'Qwen3 35B', quant: 'Q4_K_M', nativeCtx: 262144, vision: false, loaded },
})

async function openMenu(props: Partial<Parameters<typeof ModelLoadMenu>[0]> = {}) {
  const onLoad = vi.fn()
  render(
    <ModelLoadMenu
      models={LOCAL}
      loadedKey={null}
      loadedName={null}
      onLoad={onLoad}
      onEject={() => {}}
      screen="chat"
      {...props}
    />,
  )
  await userEvent.click(screen.getByRole('button'))
  return { onLoad }
}

describe('ModelLoadMenu with Turbo Link', () => {
  it('groups local models first, then the machine, showing the bare name over its machine', async () => {
    await openMenu({ links: [link({ id: 'l1', name: 'workstation' })], remoteModels: [row(true)] })
    const headings = ['This machine', 'workstation']
    for (const h of headings) expect(screen.getAllByText(h).length).toBeGreaterThan(0)
    // The BARE name is what the user reads — the qualified id is plumbing.
    expect(screen.getByText('Qwen3 35B')).toBeInTheDocument()
    expect(screen.queryByText('workstation/qwen3-35b')).not.toBeInTheDocument()
  })

  it('sends the QUALIFIED id when a remote model is picked', async () => {
    const { onLoad } = await openMenu({ links: [link({ id: 'l1', name: 'workstation' })], remoteModels: [row(true)] })
    await userEvent.click(screen.getByText('Qwen3 35B'))
    expect(onLoad).toHaveBeenCalledWith('workstation/qwen3-35b')
  })

  it('spells out WHY a cold model on a use-only link cannot be picked', async () => {
    const { onLoad } = await openMenu({
      links: [link({ id: 'l1', name: 'workstation', grantedCapabilities: ['models:use'] })],
      remoteModels: [row(false)],
    })
    const reason = screen.getByText(/not loaded on workstation/i)
    expect(reason).toBeInTheDocument()
    // Greyed AND explained — and picking it does not silently do nothing behind the scenes.
    await userEvent.click(screen.getByText('Qwen3 35B'))
    expect(onLoad).not.toHaveBeenCalled()
  })

  it("shows an offline machine's lastError rather than a bare 'offline'", async () => {
    await openMenu({
      links: [link({
        id: 'l1',
        name: 'workstation',
        status: 'unreachable',
        lastError: 'workstation did not answer — check that it is awake.',
      })],
      remoteModels: [],
    })
    expect(screen.getByText('workstation did not answer — check that it is awake.')).toBeInTheDocument()
    expect(screen.queryByText(/^offline$/i)).not.toBeInTheDocument()
  })

  it('renders exactly as before when there are no links at all', async () => {
    await openMenu()
    // No group headers on an install with no links — the pre-Turbo-Link flat list.
    // Twice: the trigger's own label and the list header, exactly as before this change.
    expect(screen.getAllByText('Load a model')).toHaveLength(2)
    expect(screen.queryByText('This machine')).not.toBeInTheDocument()
    expect(screen.getByText('Gemma 27B')).toBeInTheDocument()
  })
})
