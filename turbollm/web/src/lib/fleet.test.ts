import { describe, expect, it } from 'vitest'
import { fleetMachines, mergeFleet } from './fleet'
import type { LinkSummary } from './link-api'

/** A model-ish row. `mergeFleet` is generic and never reads a field of `T`; naming the
 *  rows is only so the assertions below read like the screens that will use them. */
interface Row {
  key: string
  name: string
}

function link(over: Partial<LinkSummary> & { id: string; name: string }): LinkSummary {
  return {
    status: 'online',
    grantedCapabilities: [],
    lastError: null,
    ...over,
  }
}

const localRows: Row[] = [
  { key: 'a', name: 'Qwen3-35B' },
  { key: 'b', name: 'Gemma-4' },
]

describe('mergeFleet', () => {
  it('sorts local rows first, ahead of every remote row', () => {
    const merged = mergeFleet(localRows, [
      { link: link({ id: 'l1', name: 'workstation' }), rows: [{ key: 'r', name: 'Llama' }] },
    ])

    expect(merged.map((r) => r.origin.kind)).toEqual(['local', 'local', 'remote'])
    expect(merged.slice(0, 2).map((r) => r.row)).toEqual(localRows)
  })

  it('preserves the local rows exactly, in order, with a local origin', () => {
    const merged = mergeFleet(localRows, [])

    expect(merged).toEqual([
      { origin: { kind: 'local' }, row: localRows[0] },
      { origin: { kind: 'local' }, row: localRows[1] },
    ])
  })

  it('returns just the local rows for an empty fleet', () => {
    expect(mergeFleet(localRows, [])).toHaveLength(2)
    expect(mergeFleet([], [])).toEqual([])
  })

  it('groups remote rows by machine, keeping each machine contiguous', () => {
    const merged = mergeFleet([], [
      { link: link({ id: 'l1', name: 'workstation' }), rows: [{ key: 'a', name: 'A' }, { key: 'b', name: 'B' }] },
      { link: link({ id: 'l2', name: 'laptop' }), rows: [{ key: 'c', name: 'C' }] },
    ])

    expect(merged.map((r) => (r.origin.kind === 'remote' ? r.origin.machine : 'local'))).toEqual([
      'workstation',
      'workstation',
      'laptop',
    ])
  })

  it('is stable: the same input produces the same order every call', () => {
    // Deliberately NOT sorted by name — the fleet order is the order the caller lists
    // the links in, so it can never depend on `Object.keys` ordering or on a mutable
    // field (a machine that goes offline and comes back must not jump the list).
    const fleet = [
      { link: link({ id: 'l2', name: 'zulu' }), rows: [{ key: 'a', name: 'A' }] },
      { link: link({ id: 'l1', name: 'alpha' }), rows: [{ key: 'b', name: 'B' }] },
      { link: link({ id: 'l3', name: 'mike' }), rows: [{ key: 'c', name: 'C' }] },
    ]

    const first = mergeFleet(localRows, fleet)
    const second = mergeFleet(localRows, fleet)

    expect(second).toEqual(first)
    expect(first.map((r) => (r.origin.kind === 'remote' ? r.origin.linkId : 'local'))).toEqual([
      'local',
      'local',
      'l2',
      'l1',
      'l3',
    ])
  })

  it('gives an OFFLINE link zero rows — a listed-but-unusable row is worse than none', () => {
    const merged = mergeFleet(localRows, [
      {
        link: link({ id: 'l1', name: 'workstation', status: 'unreachable', lastError: 'Connection refused.' }),
        rows: [{ key: 'r', name: 'Llama' }],
      },
    ])

    expect(merged.every((r) => r.origin.kind === 'local')).toBe(true)
    expect(merged).toHaveLength(2)
  })

  it('gives every non-online status zero rows', () => {
    for (const status of ['unknown', 'unreachable', 'revoked', 'incompatible'] as const) {
      const merged = mergeFleet([], [
        { link: link({ id: 'l1', name: 'workstation', status }), rows: [{ key: 'r', name: 'Llama' }] },
      ])
      expect(merged, status).toEqual([])
    }
  })

  it('still REPRESENTS an offline machine, so the UI can show why it has no rows', () => {
    const fleet = [
      {
        link: link({ id: 'l1', name: 'workstation', status: 'unreachable', lastError: 'Connection refused.' }),
        rows: [{ key: 'r', name: 'Llama' }],
      },
      { link: link({ id: 'l2', name: 'laptop' }), rows: [{ key: 'c', name: 'C' }] },
    ]

    expect(fleetMachines(fleet)).toEqual([
      {
        linkId: 'l1',
        machine: 'workstation',
        status: 'unreachable',
        note: 'Connection refused.',
        rowCount: 0,
      },
      { linkId: 'l2', machine: 'laptop', status: 'online', note: null, rowCount: 1 },
    ])
  })

  it('falls back to a note that NAMES the machine when the link carries no lastError', () => {
    const [machine] = fleetMachines([
      { link: link({ id: 'l1', name: 'workstation', status: 'unreachable' }), rows: [] },
    ])

    expect(machine.note).toMatch(/workstation/)
  })

  it('gives two machines with an identically-named model two distinct rows', () => {
    const same: Row = { key: 'Qwen3-35B', name: 'Qwen3-35B' }
    const merged = mergeFleet([], [
      { link: link({ id: 'l1', name: 'workstation' }), rows: [{ ...same }] },
      { link: link({ id: 'l2', name: 'laptop' }), rows: [{ ...same }] },
    ])

    expect(merged).toHaveLength(2)
    expect(merged[0].origin).toEqual({ kind: 'remote', linkId: 'l1', machine: 'workstation' })
    expect(merged[1].origin).toEqual({ kind: 'remote', linkId: 'l2', machine: 'laptop' })
    expect(merged[0].origin).not.toEqual(merged[1].origin)
  })

  it('keeps two links that share a machine NAME apart by link id', () => {
    // Names are user-editable and not unique; the id is what addresses the host.
    const merged = mergeFleet([], [
      { link: link({ id: 'l1', name: 'workstation' }), rows: [{ key: 'a', name: 'A' }] },
      { link: link({ id: 'l2', name: 'workstation' }), rows: [{ key: 'a', name: 'A' }] },
    ])

    expect(merged.map((r) => (r.origin.kind === 'remote' ? r.origin.linkId : ''))).toEqual(['l1', 'l2'])
  })

  it('does not mutate its inputs', () => {
    const local = [...localRows]
    const fleet = [{ link: link({ id: 'l1', name: 'workstation' }), rows: [{ key: 'r', name: 'Llama' }] }]
    mergeFleet(local, fleet)

    expect(local).toEqual(localRows)
    expect(fleet[0].rows).toEqual([{ key: 'r', name: 'Llama' }])
  })
})
