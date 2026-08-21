import { describe, expect, it } from 'vitest'
import { findRemoteChoice, groupModelChoices, selectModel, type RemoteModelRow } from './remote-models'
import type { LinkRecord } from './link-api'
import type { ModelEntry } from './types'

/** Minimal `ModelEntry` — the picker reads only these fields, and spelling out all
 *  forty would bury what each case is actually about. */
function local(over: Partial<ModelEntry> & { key: string; name: string }): ModelEntry {
  return { quant: 'Q4_K_M', incomplete: false, parseError: null, loaded: false, ...over } as ModelEntry
}

// `id` is a BRANDED LinkRecordId in the real type — deliberately untypeable from a plain
// string so an ApiKey id can never be passed where a link-record id belongs. Tests build
// fixtures from literals, so the brand is dropped here and restored by the cast below.
function link(over: Omit<Partial<LinkRecord>, 'id'> & { id: string; name: string }): LinkRecord {
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
  } as LinkRecord
}

function row(linkId: string, machine: string, over: Partial<RemoteModelRow['model']> & { key: string; name: string }): RemoteModelRow {
  return { linkId, machine, model: { quant: 'Q4_K_M', nativeCtx: 8192, vision: false, loaded: false, ...over } }
}

const LOCAL_MODELS = [local({ key: 'gemma-27b', name: 'Gemma 27B' })]

describe('groupModelChoices', () => {
  it('puts the local group first, then one group per machine, in link order', () => {
    const groups = groupModelChoices({
      local: LOCAL_MODELS,
      links: [link({ id: 'l1', name: 'workstation' }), link({ id: 'l2', name: 'kaggle' })],
      remote: [
        row('l1', 'workstation', { key: 'qwen3-35b', name: 'Qwen3 35B', loaded: true }),
        row('l2', 'kaggle', { key: 'llama-70b', name: 'Llama 70B', loaded: true }),
      ],
    })
    expect(groups.map((g) => g.kind)).toEqual(['local', 'machine', 'machine'])
    expect(groups.map((g) => g.label)).toEqual(['This machine', 'workstation', 'kaggle'])
    expect(groups[0].choices.map((c) => c.id)).toEqual(['gemma-27b'])
  })

  it('shows the BARE model name with the machine as subtext, but sends the qualified id', () => {
    const [, machine] = groupModelChoices({
      local: [],
      links: [link({ id: 'l1', name: 'workstation' })],
      remote: [row('l1', 'workstation', { key: 'unsloth/Qwen3-35B-GGUF/Q4_K_M.gguf', name: 'Qwen3 35B', loaded: true })],
    })
    const choice = machine.choices[0]
    // What the user reads: the short name, never the qualified id.
    expect(choice.name).toBe('Qwen3 35B')
    expect(choice.machine).toBe('workstation')
    expect(choice.remote).toBe(true)
    // What travels over the wire: `<machine>/<modelKey>`, split on the FIRST slash only,
    // so a Hugging Face key with its own slashes survives intact.
    expect(choice.id).toBe('workstation/unsloth/Qwen3-35B-GGUF/Q4_K_M.gguf')
  })

  it('local choices are never marked remote and carry no machine subtext', () => {
    const [localGroup] = groupModelChoices({ local: LOCAL_MODELS, links: [], remote: [] })
    expect(localGroup.choices[0].remote).toBe(false)
    expect(localGroup.choices[0].machine).toBeUndefined()
    expect(localGroup.choices[0].disabled).toBe(false)
  })

  it('disables a COLD model on a link with neither wake nor load — with the reason spelled out', () => {
    const [, machine] = groupModelChoices({
      local: [],
      links: [link({ id: 'l1', name: 'workstation', grantedCapabilities: ['models:use'] })],
      remote: [row('l1', 'workstation', { key: 'qwen3-35b', name: 'Qwen3 35B', loaded: false })],
    })
    const choice = machine.choices[0]
    expect(choice.disabled).toBe(true)
    // A disabled control with no reason sends the user hunting for a problem that isn't there.
    expect(choice.disabledReason).toBeTruthy()
    expect(choice.disabledReason).toMatch(/not loaded on workstation/i)
  })

  it('leaves a cold model enabled when the host granted wake OR load', () => {
    for (const cap of ['models:wake', 'models:load'] as const) {
      const [, machine] = groupModelChoices({
        local: [],
        links: [link({ id: 'l1', name: 'workstation', grantedCapabilities: ['models:use', cap] })],
        remote: [row('l1', 'workstation', { key: 'qwen3-35b', name: 'Qwen3 35B', loaded: false })],
      })
      expect(machine.choices[0].disabled, `granted ${cap}`).toBe(false)
      expect(machine.choices[0].disabledReason).toBeUndefined()
    }
  })

  it('never disables an ALREADY-LOADED remote model, even with only models:use', () => {
    const [, machine] = groupModelChoices({
      local: [],
      links: [link({ id: 'l1', name: 'workstation', grantedCapabilities: ['models:use'] })],
      remote: [row('l1', 'workstation', { key: 'qwen3-35b', name: 'Qwen3 35B', loaded: true })],
    })
    expect(machine.choices[0].disabled).toBe(false)
  })

  it('reads capability from the link record the HOST reported, not from a local guess', () => {
    // Same request, two links: the only difference is what the host granted. If this ever
    // came from a local default, both would render the same way.
    const groups = groupModelChoices({
      local: [],
      links: [
        link({ id: 'l1', name: 'workstation', grantedCapabilities: ['models:use'] }),
        link({ id: 'l2', name: 'kaggle', grantedCapabilities: ['models:use', 'models:load'] }),
      ],
      remote: [
        row('l1', 'workstation', { key: 'a', name: 'A', loaded: false }),
        row('l2', 'kaggle', { key: 'a', name: 'A', loaded: false }),
      ],
    })
    expect(groups[1].choices[0].disabled).toBe(true)
    expect(groups[2].choices[0].disabled).toBe(false)
  })

  it("an offline link's group shows its lastError, not a bare 'offline'", () => {
    const groups = groupModelChoices({
      local: [],
      links: [link({
        id: 'l1',
        name: 'workstation',
        status: 'unreachable',
        lastError: 'workstation did not answer — check that it is awake and the tunnel is up.',
      })],
      remote: [],
    })
    const machine = groups[1]
    expect(machine.status).toBe('unreachable')
    expect(machine.note).toBe('workstation did not answer — check that it is awake and the tunnel is up.')
    expect(machine.note).not.toBe('offline')
    expect(machine.choices).toEqual([])
  })

  it('falls back to a named sentence when an offline link has no lastError', () => {
    const [, machine] = groupModelChoices({
      local: [],
      links: [link({ id: 'l1', name: 'workstation', status: 'revoked', lastError: null })],
      remote: [],
    })
    expect(machine.note).toBeTruthy()
    expect(machine.note).toMatch(/workstation/)
  })

  it('drops cached rows for a link that is no longer online', () => {
    // The peer's catalog is re-read live; a machine that dropped must stop advertising
    // models immediately rather than leaving pickable rows that every prompt 503s on.
    const [, machine] = groupModelChoices({
      local: [],
      links: [link({ id: 'l1', name: 'workstation', status: 'unreachable', lastError: 'gone' })],
      remote: [row('l1', 'workstation', { key: 'qwen3-35b', name: 'Qwen3 35B', loaded: true })],
    })
    expect(machine.choices).toEqual([])
  })

  it('ignores remote rows whose link is not in the list at all', () => {
    const groups = groupModelChoices({
      local: [],
      links: [],
      remote: [row('ghost', 'ghost', { key: 'x', name: 'X', loaded: true })],
    })
    expect(groups).toHaveLength(1)
    expect(groups[0].kind).toBe('local')
  })

  it('hides unusable local entries the way the picker already does', () => {
    const [localGroup] = groupModelChoices({
      local: [
        local({ key: 'ok', name: 'OK' }),
        local({ key: 'partial', name: 'Partial', incomplete: true }),
        local({ key: 'broken', name: 'Broken', parseError: 'bad gguf' }),
      ],
      links: [],
      remote: [],
    })
    expect(localGroup.choices.map((c) => c.id)).toEqual(['ok'])
  })

  it('marks the currently-loaded local model so the picker can tick it', () => {
    const [localGroup] = groupModelChoices({
      local: [local({ key: 'gemma-27b', name: 'Gemma 27B', loaded: true })],
      links: [],
      remote: [],
    })
    expect(localGroup.choices[0].loaded).toBe(true)
  })
})

// ── findRemoteChoice (final-review C-1) ────────────────────────────────────────────────
// The chat screen's "is this id another machine's?" test. Getting it wrong in either
// direction is a shipped bug: a false negative sends a qualified id to the LOCAL engine
// loader (which aborts in-flight generations and loads a different model), and a false
// positive stops an ordinary local model with a slash in its key from ever loading.

describe('findRemoteChoice', () => {
  const onlineLink = { id: 'l1', name: 'workstation', status: 'online', grantedCapabilities: ['models:use'] } as unknown as LinkRecord
  const rows: RemoteModelRow[] = [{
    linkId: 'l1',
    machine: 'workstation',
    model: { key: 'qwen3-35b', name: 'Qwen3 35B', quant: 'Q4_K_M', nativeCtx: 262144, vision: false, loaded: true },
  }]

  it('resolves the qualified id the dropdown emits', () => {
    const hit = findRemoteChoice('workstation/qwen3-35b', [onlineLink], rows)
    expect(hit).toEqual({ id: 'workstation/qwen3-35b', name: 'Qwen3 35B', machine: 'workstation' })
  })

  it('leaves a LOCAL key that happens to contain a slash alone', () => {
    expect(findRemoteChoice('unsloth/Qwen3-GGUF', [onlineLink], rows)).toBeUndefined()
    expect(findRemoteChoice('gemma-27b', [onlineLink], rows)).toBeUndefined()
  })

  it('does not resolve against a machine that is no longer online', () => {
    const offline = { ...onlineLink, status: 'unreachable' } as unknown as LinkRecord
    expect(findRemoteChoice('workstation/qwen3-35b', [offline], rows)).toBeUndefined()
  })

  it('is empty on an install with no links at all', () => {
    expect(findRemoteChoice('workstation/qwen3-35b', [], [])).toBeUndefined()
  })
})

describe('selectModel: what a pick in the chat menu actually does', () => {
  const onlineLink = { id: 'l1', name: 'workstation', status: 'online', grantedCapabilities: ['models:use'] } as unknown as LinkRecord
  const rows: RemoteModelRow[] = [{
    linkId: 'l1',
    machine: 'workstation',
    model: { key: 'qwen3-35b', name: 'Qwen3 35B', quant: 'Q4_K_M', nativeCtx: 262144, vision: false, loaded: true },
  }]

  it('a remote pick is a ROUTING choice — never a local engine load', () => {
    // The shipped bug: this id went to POST /api/v1/engine/start, which aborts every
    // in-flight generation in every conversation before it even looks the key up.
    expect(selectModel('workstation/qwen3-35b', [onlineLink], rows)).toEqual({
      kind: 'remote', id: 'workstation/qwen3-35b', name: 'Qwen3 35B', machine: 'workstation',
    })
  })

  it('a local pick still loads the local engine', () => {
    expect(selectModel('gemma-27b', [onlineLink], rows)).toEqual({ kind: 'local', key: 'gemma-27b' })
  })

  it('a local key with a slash in it is a LOCAL load, not a route', () => {
    expect(selectModel('unsloth/Qwen3-GGUF', [onlineLink], rows)).toEqual({ kind: 'local', key: 'unsloth/Qwen3-GGUF' })
  })

  it('a model on a machine that dropped is not routable — it falls back to a local load', () => {
    const offline = { ...onlineLink, status: 'unreachable' } as unknown as LinkRecord
    expect(selectModel('workstation/qwen3-35b', [offline], rows).kind).toBe('local')
  })
})
