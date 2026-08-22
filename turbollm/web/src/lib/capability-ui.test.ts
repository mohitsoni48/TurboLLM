import { describe, expect, it } from 'vitest'
import { actionState, capabilityReason, machinesMissingCapability } from './capability-ui'
import type { FleetOrigin } from './fleet'
import type { LinkCapability, LinkStatus, LinkSummary } from './link-api'

function link(over: Partial<LinkSummary> = {}): LinkSummary {
  return {
    id: 'l1',
    name: 'workstation',
    status: 'online',
    grantedCapabilities: [],
    lastError: null,
    ...over,
  }
}

const REMOTE: FleetOrigin = { kind: 'remote', linkId: 'l1', machine: 'workstation' }
const LOCAL: FleetOrigin = { kind: 'local' }

/** Narrow for the assertions — a disabled state is the only one with a `reason`. */
function reasonOf(state: ReturnType<typeof actionState>): string {
  expect(state.enabled).toBe(false)
  return state.enabled ? '' : state.reason
}

describe('actionState', () => {
  it('a local row is always enabled', () => {
    for (const cap of ['models:load', 'downloads:write', 'config:write'] as LinkCapability[]) {
      expect(actionState(cap, LOCAL)).toEqual({ enabled: true })
    }
    // Even with a link record handed in, a local row never consults it.
    expect(actionState('models:load', LOCAL, link({ status: 'revoked' }))).toEqual({ enabled: true })
  })

  it('a remote row with the capability on an online link is enabled', () => {
    const state = actionState('models:load', REMOTE, link({ grantedCapabilities: ['models:use', 'models:load'] }))
    expect(state).toEqual({ enabled: true })
  })

  it('a remote row WITHOUT the capability is disabled and names BOTH the capability and the machine', () => {
    const state = actionState('models:load', REMOTE, link({ grantedCapabilities: ['models:use'] }))

    expect(state.enabled).toBe(false)
    const reason = reasonOf(state)
    expect(reason).toMatch(/models:load/)
    expect(reason).toMatch(/workstation/)
  })

  it('an OFFLINE link is disabled for CONNECTIVITY, not for permissions', () => {
    // Capability deliberately absent too: connectivity must win, or the user goes hunting
    // for a permission problem that does not exist.
    const state = actionState('models:load', REMOTE, link({ status: 'unreachable', grantedCapabilities: [] }))
    const reason = reasonOf(state)

    expect(reason).toMatch(/offline/i)
    expect(reason).not.toMatch(/grant/i)
  })

  it('does NOT append the link’s lastError, which only ever repeats the sentence', () => {
    // `applyProbeResult` sets a failing link's `lastError` to `describeStatus(status, name)`
    // — the same fact the sentence above already states — so appending it produced
    // "workstation is offline, so this action is unavailable. workstation is offline or
    // unreachable." One statement of one fact.
    const state = actionState(
      'models:load',
      REMOTE,
      link({ status: 'unreachable', lastError: 'workstation is offline or unreachable.' }),
    )
    const reason = reasonOf(state)
    expect(reason).toBe('workstation is offline, so this action is unavailable.')
    expect(reason.match(/offline/gi)).toHaveLength(1)
  })

  it('a REVOKED link says revoked and points at relinking', () => {
    const state = actionState(
      'models:load',
      REMOTE,
      link({ status: 'revoked', grantedCapabilities: ['models:load'] }),
    )
    const reason = reasonOf(state)

    expect(reason).toMatch(/revoked/i)
    expect(reason).toMatch(/relink/i)
    expect(reason).toMatch(/workstation/)
  })

  it('an INCOMPATIBLE link says so and points at updating, not at permissions', () => {
    const state = actionState(
      'downloads:write',
      REMOTE,
      link({ status: 'incompatible', grantedCapabilities: ['downloads:write'] }),
    )
    const reason = reasonOf(state)

    expect(reason).toMatch(/incompatible/i)
    expect(reason).toMatch(/update/i)
    expect(reason).toMatch(/workstation/)
    expect(reason).not.toMatch(/grant/i)
  })

  it('an UNKNOWN (never yet checked) link says it has not been checked', () => {
    const state = actionState('models:load', REMOTE, link({ status: 'unknown', grantedCapabilities: ['models:load'] }))
    const reason = reasonOf(state)

    expect(reason).toMatch(/not been checked/i)
    expect(reason).toMatch(/workstation/)
  })

  it('never yields an empty or undefined reason for ANY status, for any capability', () => {
    const statuses: LinkStatus[] = ['unknown', 'online', 'unreachable', 'revoked', 'incompatible']
    for (const status of statuses) {
      for (const granted of [[], ['models:load'] as LinkCapability[]]) {
        const state = actionState('models:load', REMOTE, link({ status, grantedCapabilities: granted }))
        if (state.enabled) {
          expect([status, granted.length], 'only a granted online link may be enabled').toEqual(['online', 1])
          continue
        }
        expect(typeof state.reason, status).toBe('string')
        expect(state.reason.length, status).toBeGreaterThan(0)
        expect(state.reason, status).not.toMatch(/undefined/)
      }
    }
  })

  it('a remote row with NO link record is disabled, naming the machine', () => {
    // The screens key their link records by id; a row whose machine has just been deleted
    // must not silently render as clickable.
    const reason = reasonOf(actionState('models:load', REMOTE))

    expect(reason).toMatch(/workstation/)
    expect(reason.length).toBeGreaterThan(0)
  })

  it('uses the link’s LIVE name over the (possibly stale) name on the origin', () => {
    const state = actionState(
      'models:load',
      { kind: 'remote', linkId: 'l1', machine: 'old-name' },
      link({ name: 'renamed-box', grantedCapabilities: [] }),
    )
    expect(reasonOf(state)).toMatch(/renamed-box/)
  })
})

// ── An ONLINE machine that contributes nothing (final review I-4) ────────────────────────
//
// `fleetMachines` explains every machine that is not online, which was the whole point of
// keeping offline machines represented. A machine that is online and STILL contributes no
// rows — because the host never granted the capability its list is gated on — is the same
// confusion with none of the explanation.
describe('machinesMissingCapability', () => {
  it('explains an online machine that was never granted the list capability', () => {
    const [note] = machinesMissingCapability([link({ grantedCapabilities: ['models:load'] })], 'models:use')
    expect(note).toBeTruthy()
    expect(note!.linkId).toBe('l1')
    expect(note!.rowCount).toBe(0)
    expect(note!.note).toMatch(/models:use/)
    expect(note!.note).toMatch(/workstation/)
  })

  it('says the same thing the disabled control would say', () => {
    // One fact, one sentence. The pre-flight tooltip and the machine note must not drift
    // into two differently-worded explanations of the same missing grant.
    const [note] = machinesMissingCapability([link()], 'models:use')
    expect(note!.note).toBe(capabilityReason('models:use', 'workstation'))
  })

  it('is silent for a machine that HAS the capability, and for one that is not online', () => {
    expect(machinesMissingCapability([link({ grantedCapabilities: ['models:use'] })], 'models:use')).toEqual([])
    // A non-online machine is `fleetMachines`' business — reported twice, the user reads two
    // different reasons for one machine.
    expect(machinesMissingCapability([link({ status: 'unreachable' })], 'models:use')).toEqual([])
    expect(machinesMissingCapability([link({ status: 'revoked' })], 'models:use')).toEqual([])
  })
})
