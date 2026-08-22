import { describe, it, expect } from 'vitest'
import type { LinkSummary } from './link-api'
import { mergeFleet } from './fleet'
import {
  sourcesByLink,
  localModel,
  remoteModel,
  localDownload,
  remoteDownload,
  machineOptions,
  filterByMachine,
  remoteModelMatches,
} from './fleet-sources'
import type { ModelEntry } from './types'

function link(id: string, name: string, over: Partial<LinkSummary> = {}): LinkSummary {
  return {
    id,
    name,
    status: 'online',
    grantedCapabilities: ['models:use', 'models:load'],
    lastError: null,
    ...over,
  }
}

describe('sourcesByLink', () => {
  it('groups rows under their own link, in the order the links were listed', () => {
    const links = [link('a', 'alpha'), link('b', 'beta')]
    const rows = [
      { linkId: 'b', v: 1 },
      { linkId: 'a', v: 2 },
      { linkId: 'b', v: 3 },
    ]
    const out = sourcesByLink(links, rows, (r) => r.linkId)
    expect(out.map((s) => s.link.id)).toEqual(['a', 'b'])
    expect(out[0].rows.map((r) => r.v)).toEqual([2])
    expect(out[1].rows.map((r) => r.v)).toEqual([1, 3])
  })

  it('keeps a link with no rows, so mergeFleet/fleetMachines can still explain it', () => {
    const out = sourcesByLink([link('a', 'alpha')], [] as { linkId: string }[], (r) => r.linkId)
    expect(out).toHaveLength(1)
    expect(out[0].rows).toEqual([])
  })

  it('drops rows whose link is gone rather than inventing a source for them', () => {
    // A row can outlive its link by one poll. Rendering it would mean a row whose origin
    // names a machine that is no longer in the fleet — and whose every action would 404.
    const out = sourcesByLink([link('a', 'alpha')], [{ linkId: 'ghost' }], (r) => r.linkId)
    expect(out).toHaveLength(1)
    expect(out[0].rows).toEqual([])
  })
})

describe('row adapters', () => {
  const entry = {
    key: 'local-key',
    name: 'Qwen3',
    quant: 'Q4_K_M',
    loaded: true,
    sizeBytes: 4_000_000_000,
    nativeCtx: 32768,
    vision: false,
  } as ModelEntry

  it('carries the local ModelEntry through so local rows keep their full affordances', () => {
    const m = localModel(entry)
    expect(m.key).toBe('local-key')
    expect(m.entry).toBe(entry)
    expect(m.sizeBytes).toBe(4_000_000_000)
  })

  it('leaves a remote model without the fields the host does not disclose', () => {
    const m = remoteModel({ key: 'k', name: 'Qwen3', quant: 'Q4_K_M', nativeCtx: 8192, vision: true, loaded: false })
    expect(m.entry).toBeUndefined()
    // The host never sends a size or a path — nothing may render one for a remote row.
    expect(m.sizeBytes).toBeNull()
    expect(m.vision).toBe(true)
  })

  it('normalises local and remote downloads to the same shape', () => {
    const l = localDownload({
      id: 'd1', name: 'a.gguf', repo: 'o/r', url: 'https://x', dest: 'D:\\m\\a.gguf',
      total: 10, received: 5, status: 'downloading', error: null, bytesPerSec: 100,
      createdAt: '2026-01-01',
    })
    const r = remoteDownload({
      id: 'd2', name: 'b.gguf', repo: 'o/r', total: 10, received: 5,
      status: 'downloading', error: null, bytesPerSec: 100, createdAt: '2026-01-01',
    })
    expect(Object.keys(l).sort()).toEqual(Object.keys(r).sort())
  })

  it('never lets a local download\'s dest or url reach the shared row shape', () => {
    // The two halves render through ONE row component. If the local adapter kept `dest`,
    // that component could grow a path column that silently renders blank for every remote
    // row — or worse, a host path if the shapes were ever merged the other way.
    const l = localDownload({
      id: 'd1', name: 'a.gguf', repo: 'o/r', url: 'https://x', dest: 'D:\\m\\a.gguf',
      total: 10, received: 5, status: 'downloading', error: null, bytesPerSec: 100,
      createdAt: '2026-01-01',
    })
    expect(JSON.stringify(l)).not.toMatch(/D:/)
    expect('dest' in l).toBe(false)
    expect('url' in l).toBe(false)
  })
})

describe('machine filter', () => {
  const links = [link('a', 'alpha'), link('b', 'beta', { status: 'unreachable' })]
  const rows = mergeFleet(
    [localModel({ key: 'l', name: 'Local' } as ModelEntry)],
    sourcesByLink(links, [{ linkId: 'a', model: { key: 'r', name: 'Remote', quant: null, nativeCtx: null, vision: false, loaded: false } }], (r) => r.linkId)
      .map((s) => ({ link: s.link, rows: s.rows.map((r) => remoteModel(r.model)) })),
  )

  it('offers this machine plus every link, including the offline one', () => {
    // The offline machine must remain SELECTABLE. Dropping it from the filter is how a
    // machine silently disappears — the user cannot even ask "what happened to beta?".
    const opts = machineOptions(links)
    expect(opts.map((o) => o.id)).toEqual(['all', 'local', 'a', 'b'])
    expect(opts.find((o) => o.id === 'b')?.status).toBe('unreachable')
  })

  it('"all" returns every row untouched', () => {
    expect(filterByMachine(rows, 'all')).toHaveLength(2)
  })

  it('"local" returns only this machine\'s rows', () => {
    const out = filterByMachine(rows, 'local')
    expect(out).toHaveLength(1)
    expect(out[0].origin.kind).toBe('local')
  })

  it('a link id returns only that machine\'s rows', () => {
    const out = filterByMachine(rows, 'a')
    expect(out).toHaveLength(1)
    expect(out[0].origin).toMatchObject({ kind: 'remote', linkId: 'a' })
  })

  it('filters on link ID, not machine name, so a rename cannot orphan the selection', () => {
    const renamed = filterByMachine(
      mergeFleet([], [{ link: link('a', 'alpha-renamed'), rows: [remoteModel({ key: 'r', name: 'R', quant: null, nativeCtx: null, vision: false, loaded: false })] }]),
      'a',
    )
    expect(renamed).toHaveLength(1)
  })
})

describe('remoteModelMatches', () => {
  const m = remoteModel({ key: 'k', name: 'Qwen3-35B', quant: 'Q4', nativeCtx: null, vision: false, loaded: false })
  const vis = remoteModel({ key: 'v', name: 'Gemma Vision', quant: 'Q4', nativeCtx: null, vision: true, loaded: false })

  it('matches on the search term, case-insensitively', () => {
    expect(remoteModelMatches(m, { q: 'qwen', facet: 'all' })).toBe(true)
    expect(remoteModelMatches(m, { q: 'llama', facet: 'all' })).toBe(false)
  })

  it('can judge the vision facet, which the host does advertise', () => {
    expect(remoteModelMatches(vis, { q: '', facet: 'vision' })).toBe(true)
    expect(remoteModelMatches(m, { q: '', facet: 'vision' })).toBe(false)
  })

  it('hides remote rows for a facet this machine cannot evaluate', () => {
    // MoE/NextN/Embed come from local GGUF metadata the peer never sees. Keeping the row
    // would assert a match nobody checked.
    for (const facet of ['moe', 'nextn', 'embedding']) {
      expect(remoteModelMatches(m, { q: '', facet })).toBe(false)
    }
  })
})
