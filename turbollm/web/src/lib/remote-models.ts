// Turbo Link (ADR-376 phase 2, task 8): the chat model picker's grouping, as a PURE
// function.
//
// Everything the dropdown needs to decide — which group a model belongs to, what the user
// reads versus what travels over the wire, whether a row is pickable and why not — is
// computed here and unit-tested without a browser. `ModelLoadMenu.tsx` only renders the
// result. That split is what makes "a disabled row always carries its reason" a testable
// property instead of a thing someone has to remember while writing JSX.
import type { LinkRecord } from './link-api'
import type { LinkStatus } from './link-api'
import type { ModelEntry } from './types'

/** One model as a linked host advertises it. Mirrors `RemoteModel` in
 *  turbollm/src/link/types.ts — notably NO `path`: the host does not disclose its
 *  filesystem layout, so nothing here may expect one. */
export interface RemoteModelInfo {
  key: string
  name: string
  quant: string | null
  nativeCtx: number | null
  vision: boolean
  loaded: boolean
}

/** A row from the peer's remote catalog, keyed by link **id** — never by machine name,
 *  so renaming a link cannot orphan its models. Mirrors `RemoteModelRow` in
 *  turbollm/src/link/remote-catalog.ts. */
export interface RemoteModelRow {
  linkId: string
  machine: string
  model: RemoteModelInfo
}

/** One pickable (or deliberately un-pickable) row in the dropdown. */
export interface ModelChoice {
  /** What travels over the wire: the bare local key, or the qualified
   *  `<machine>/<modelKey>` id `ModelRouter.resolveRemote` routes on. */
  id: string
  /** What the user READS — always the bare model name. The qualified id is plumbing;
   *  showing it turns every remote row into an unreadable path. */
  name: string
  quant: string | null
  /** True for a model on another machine — drives the cloud badge. */
  remote: boolean
  /** Machine subtext, remote rows only. */
  machine?: string
  loaded: boolean
  disabled: boolean
  /** Present exactly when `disabled` is true. A greyed row with no explanation sends the
   *  user hunting for a problem that isn't there. */
  disabledReason?: string
}

export interface ModelGroup {
  /** `'local'`, or the link's id. */
  key: string
  kind: 'local' | 'machine'
  label: string
  /** Machine groups only. */
  status?: LinkStatus
  /** The actionable sentence for a non-online machine — the link's own `lastError`,
   *  never a bare "offline". */
  note?: string
  choices: ModelChoice[]
}

export const LOCAL_GROUP_LABEL = 'This machine'

/** Qualified remote id, mirroring `formatRemoteId` in turbollm/src/link/model-id.ts.
 *  The counterpart parser splits on the FIRST slash only, so a model key carrying its own
 *  slashes (`unsloth/Qwen3-35B-GGUF/Q4_K_M.gguf`) round-trips unharmed. */
export function formatRemoteId(machineName: string, modelKey: string): string {
  return `${machineName}/${modelKey}`
}

/** Why a non-online machine has no models, when the link itself didn't say.
 *  Names the machine: this list can hold several, so "Not reachable." on its own would
 *  not tell the user WHICH one to go and wake up. */
function fallbackNote(name: string, status: LinkStatus): string {
  return status === 'unknown' ? `${name} has not been checked yet.` : `${name} is not reachable.`
}

/** A cold model can only be served if the host granted the peer the right to bring it up.
 *  Read from `grantedCapabilities` — what the HOST reported at handshake — never from a
 *  local assumption about what a link "probably" allows. */
function canBringUp(link: LinkRecord): boolean {
  return link.grantedCapabilities.includes('models:wake') || link.grantedCapabilities.includes('models:load')
}

/**
 * Group every model this machine can chat with: local models first, then one group per
 * linked machine in the order the links are listed.
 *
 * A machine that is not `online` contributes NO choices, whatever the catalog still holds
 * — the same rule `RemoteCatalog` enforces server-side. A listed-but-unusable model is
 * worse than an absent one: the user picks it and every prompt 503s.
 */
export function groupModelChoices({
  local,
  links,
  remote,
}: {
  local: ModelEntry[]
  links: LinkRecord[]
  remote: RemoteModelRow[]
}): ModelGroup[] {
  const localGroup: ModelGroup = {
    key: 'local',
    kind: 'local',
    label: LOCAL_GROUP_LABEL,
    choices: local
      .filter((m) => !m.incomplete && !m.parseError)
      .map((m) => ({
        id: m.key,
        name: m.name,
        quant: m.quant ?? null,
        remote: false,
        loaded: Boolean(m.loaded),
        disabled: false,
      })),
  }

  const byLink = new Map<string, RemoteModelRow[]>()
  for (const r of remote) {
    const list = byLink.get(r.linkId)
    if (list) list.push(r)
    else byLink.set(r.linkId, [r])
  }

  const machineGroups = links.map((link): ModelGroup => {
    // The link's LIVE display name, not the (possibly stale) `machine` on the cached row:
    // the qualified id has to name the machine the router will resolve, and the router
    // resolves against the link record.
    const name = link.name
    if (link.status !== 'online') {
      return {
        key: link.id,
        kind: 'machine',
        label: name,
        status: link.status,
        note: link.lastError ?? fallbackNote(name, link.status),
        choices: [],
      }
    }
    const mayBringUp = canBringUp(link)
    return {
      key: link.id,
      kind: 'machine',
      label: name,
      status: link.status,
      choices: (byLink.get(link.id) ?? []).map((r) => {
        const cold = !r.model.loaded && !mayBringUp
        return {
          id: formatRemoteId(name, r.model.key),
          name: r.model.name,
          quant: r.model.quant,
          remote: true,
          machine: name,
          loaded: r.model.loaded,
          disabled: cold,
          ...(cold
            ? { disabledReason: `Not loaded on ${name} — this link may not load it.` }
            : {}),
        }
      }),
    }
  })

  return [localGroup, ...machineGroups]
}

/** True when there is nothing but the local group — i.e. this install has no links, which
 *  is every install until someone adds one. The picker renders that case exactly as it did
 *  before Turbo Link existed: a flat list with no group headers. */
export function isFlat(groups: ModelGroup[]): boolean {
  return groups.length === 1
}

/** The remote model a qualified id names, or undefined for a local id.
 *
 *  This is the PEER-SIDE half of `ModelRouter.resolveRemoteTarget` (final-review C-1): the
 *  chat screen has to know, before it does anything, whether the id the picker just handed
 *  it belongs to another machine — because a remote id must NEVER reach the local engine
 *  loader (`POST /api/v1/engine/start`), which aborts every in-flight generation and then
 *  loads something else entirely.
 *
 *  Matched against the rows the daemon actually advertises, using the same
 *  `formatRemoteId(link.name, model.key)` the dropdown emitted — never a `includes('/')`
 *  test, which would misread a local model key that carries its own slashes
 *  (`unsloth/Qwen3-GGUF`) as remote and silently stop it loading. */
export function findRemoteChoice(
  id: string,
  links: LinkRecord[],
  remote: RemoteModelRow[],
): { id: string; name: string; machine: string } | undefined {
  for (const link of links) {
    if (link.status !== 'online') continue
    for (const row of remote) {
      if (row.linkId !== link.id) continue
      if (formatRemoteId(link.name, row.model.key) !== id) continue
      return { id, name: row.model.name, machine: link.name }
    }
  }
  return undefined
}

/** What picking `id` in the model menu MEANS. */
export type ModelSelection =
  /** Another machine already has this model up. Route to it — no engine action at all. */
  | { kind: 'remote'; id: string; name: string; machine: string }
  /** This machine's own library. Load it, and stop routing to any machine. */
  | { kind: 'local'; key: string }

/** The chat screen's model-pick decision, as a pure function.
 *
 *  Extracted from the click handler deliberately (final-review C-1). The bug that shipped
 *  was not in what the menu EMITS — `ModelLoadMenu.remote.test.tsx` already pinned the
 *  qualified id — it was in what the receiver did with it: hand it to
 *  `POST /api/v1/engine/start`, which runs `d.bench.cancel()` and `abortAllInFlightChats()`
 *  before it even looks the key up, misses in the local scanner, and then 409s or loads a
 *  different local model. Testing the handoff alone is exactly how that stayed green, so
 *  the branch itself is the unit now. */
export function selectModel(
  id: string,
  links: LinkRecord[],
  remote: RemoteModelRow[],
): ModelSelection {
  const hit = findRemoteChoice(id, links, remote)
  return hit ? { kind: 'remote', ...hit } : { kind: 'local', key: id }
}
