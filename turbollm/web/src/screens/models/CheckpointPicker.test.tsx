// One row per downloadable checkpoint folder of a safetensors repo (ADR-434 (h)).
//
// An OpenJev-style repo ships several model folders side by side. Each gets its own size, fit
// dot and action, and an unverified architecture is TAGGED rather than hidden — the founder's
// call in (h): the user decides whether to try it, the UI does not decide for them.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { CheckpointPicker, shadowingCheckpoint } from './CheckpointPicker'
import { track } from '../../lib/api'
import type { HfCheckpoint } from '../../lib/types'

vi.mock('../../lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/api')>()),
  track: vi.fn(),
}))

function checkpoint(over: Partial<HfCheckpoint> = {}): HfCheckpoint {
  return {
    dir: 'qwen3.5-4b-nli-v2',
    name: 'qwen3.5-4b-nli-v2',
    sizeBytes: 9e9,
    files: [],
    jev: { architecture: 'Qwen3_5ForSequenceClassification', verified: true },
    downloaded: false,
    localKey: null,
    ...over,
  }
}

const V2 = checkpoint({ downloaded: true, localKey: 'v2-key' })
const V1 = checkpoint({ dir: 'qwen3.5-4b-nli-v1', name: 'qwen3.5-4b-nli-v1', sizeBytes: 4e9 })
const BIG = checkpoint({
  dir: 'qwen3.5-35b-a3b-nli',
  name: 'qwen3.5-35b-a3b-nli',
  sizeBytes: 70e9,
  jev: { architecture: 'Qwen3_5MoeForSequenceClassification', verified: false },
})

const onDownload = vi.fn()
const onLoad = vi.fn()

function renderPicker(over: Partial<Parameters<typeof CheckpointPicker>[0]> = {}) {
  return render(
    <CheckpointPicker
      repo="AlexWortega/openjev"
      checkpoints={[V2, V1, BIG]}
      vramMb={16000}
      blockedByGate={false}
      enqueuePending={false}
      onDownload={onDownload}
      onLoad={onLoad}
      {...over}
    />,
  )
}

beforeEach(() => {
  onDownload.mockClear()
  onLoad.mockClear()
  vi.mocked(track).mockClear()
})

describe('CheckpointPicker — rows', () => {
  it('lists every checkpoint with its own name and size', () => {
    renderPicker()
    expect(screen.getByText('qwen3.5-4b-nli-v2')).toBeTruthy()
    expect(screen.getByText('9.0 GB')).toBeTruthy()
    expect(screen.getByText('qwen3.5-4b-nli-v1')).toBeTruthy()
    expect(screen.getByText('4.0 GB')).toBeTruthy()
    expect(screen.getByText('qwen3.5-35b-a3b-nli')).toBeTruthy()
    expect(screen.getByText('70.0 GB')).toBeTruthy()
  })

  it('rates each checkpoint against this GPU with the shared fit helper', () => {
    const { container } = renderPicker()
    const titles = [...container.querySelectorAll('[title]')].map((e) => e.getAttribute('title'))
    expect(titles).toContain('Fits comfortably on your GPU.')
    expect(titles).toContain('Larger than your VRAM — will spill to system RAM.')
  })

  it('marks a Jev checkpoint, and tags an unverified architecture rather than hiding it', () => {
    renderPicker()
    expect(screen.getAllByText('Jev model')).toHaveLength(3)
    expect(screen.getAllByText('Not verified')).toHaveLength(1)
  })

  it('says nothing about Jev for a plain safetensors checkpoint', () => {
    renderPicker({ checkpoints: [checkpoint({ jev: null })] })
    expect(screen.queryByText('Jev model')).toBeNull()
    expect(screen.queryByText('Not verified')).toBeNull()
  })

  it('shows a checkpoint already in the library as downloaded', () => {
    renderPicker()
    expect(screen.getAllByText('Downloaded')).toHaveLength(1)
  })
})

describe('CheckpointPicker — actions', () => {
  it('offers Load for a downloaded checkpoint and Download for the rest', () => {
    renderPicker()
    expect(screen.getAllByRole('button', { name: 'Load' })).toHaveLength(1)
    expect(screen.getAllByRole('button', { name: 'Download' })).toHaveLength(2)
  })

  it('downloads THAT row\'s checkpoint, not the first one', async () => {
    renderPicker()
    await userEvent.click(screen.getAllByRole('button', { name: 'Download' })[1])
    expect(onDownload).toHaveBeenCalledWith(BIG)
    expect(track).toHaveBeenCalledWith('models', 'download_hf_checkpoint')
  })

  it('loads the downloaded checkpoint', async () => {
    renderPicker()
    await userEvent.click(screen.getByRole('button', { name: 'Load' }))
    expect(onLoad).toHaveBeenCalledWith(V2)
    expect(track).toHaveBeenCalledWith('models', 'load_hf_checkpoint')
  })

  it('offers Download, not Load, for a checkpoint whose local key is unknown', () => {
    renderPicker({ checkpoints: [checkpoint({ downloaded: true, localKey: null })] })
    expect(screen.queryByRole('button', { name: 'Load' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Download' })).toBeTruthy()
  })

  it('refuses to queue another download while one is being enqueued', () => {
    renderPicker({ enqueuePending: true })
    for (const b of screen.getAllByRole('button', { name: 'Download' })) expect(b).toBeDisabled()
  })

  it('refuses to download from a gated repo with no token', () => {
    renderPicker({ blockedByGate: true })
    for (const b of screen.getAllByRole('button', { name: 'Download' })) expect(b).toBeDisabled()
  })
})

// The scanner does not list a model folder that sits inside another model's folder, so a repo
// with BOTH a root checkpoint and nested ones can be downloaded into a library that then shows
// only one of them. Q2's approved default is to say so on the row, up front.
const ROOT = checkpoint({ dir: '', name: 'openjev', sizeBytes: 1e9 })
const OUTER = checkpoint({ dir: 'a', name: 'a', sizeBytes: 1e9 })
const INNER = checkpoint({ dir: 'a/b', name: 'b', sizeBytes: 1e9 })
const WARNING = (name: string) =>
  `Won't show in your library if "${name}" is also downloaded — TurboLLM doesn't list a model folder inside another model's folder.`

describe('shadowingCheckpoint', () => {
  it('treats the repo root as the ancestor of every nested folder', () => {
    expect(shadowingCheckpoint(V1, [ROOT, V1])).toBe(ROOT)
  })

  it('leaves sibling folders alone', () => {
    expect(shadowingCheckpoint(V1, [V2, V1, BIG])).toBeNull()
  })

  it('does not call a checkpoint its own ancestor', () => {
    expect(shadowingCheckpoint(ROOT, [ROOT, V1])).toBeNull()
  })

  it('needs a whole path segment, not a shared prefix', () => {
    const lookalike = checkpoint({ dir: 'a-big', name: 'a-big' })
    expect(shadowingCheckpoint(lookalike, [OUTER, lookalike])).toBeNull()
  })
})

describe('CheckpointPicker — checkpoints the library would hide', () => {
  it('warns on every nested row when the repo root is downloadable too', () => {
    renderPicker({ checkpoints: [ROOT, V2, V1] })
    expect(screen.getAllByText(WARNING('openjev'))).toHaveLength(2)
  })

  it('says nothing when every checkpoint is a sibling folder', () => {
    renderPicker()
    expect(screen.queryByText(/Won't show in your library/)).toBeNull()
  })

  it('warns on the inner folder only, naming the one that shadows it', () => {
    renderPicker({ checkpoints: [OUTER, INNER] })
    expect(screen.getAllByText(WARNING('a'))).toHaveLength(1)
  })
})
