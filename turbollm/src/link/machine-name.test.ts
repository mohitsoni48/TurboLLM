import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { FALLBACK_MACHINE_NAME, isValidMachineName, sanitizeMachineName, uniqueMachineName } from './machine-name'
import { parseRemoteId } from './model-id'
import { applyProbeResult } from './apply-probe'
import type { LinkRecord } from './types'

describe('machine-name: the rule that keeps a qualified id parseable', () => {
  it('rejects a name carrying the id separator', () => {
    assert.equal(isValidMachineName('lab/rig'), false)
    assert.equal(isValidMachineName('lab\\rig'), false)
    assert.equal(isValidMachineName('   '), false)
    assert.equal(isValidMachineName('x'.repeat(65)), false)
    assert.equal(isValidMachineName('workstation'), true)
    assert.equal(isValidMachineName('Ruben’s MacBook Pro'), true)
  })

  it('sanitises a separator out rather than leaving it to the parser', () => {
    assert.equal(sanitizeMachineName('lab/rig'), 'lab-rig')
    assert.equal(sanitizeMachineName('lab\\rig'), 'lab-rig')
    assert.equal(sanitizeMachineName('  spaced   out  '), 'spaced out')
    // A name of nothing but separators has no usable label left.
    assert.equal(sanitizeMachineName('///'), FALLBACK_MACHINE_NAME)
    assert.equal(sanitizeMachineName(undefined), FALLBACK_MACHINE_NAME)
    assert.equal(sanitizeMachineName('x'.repeat(200)).length, 64)
  })

  it('the sanitised name round-trips through parseRemoteId as ONE machine segment', () => {
    // The whole point: `lab/rig/Qwen3-35B` parses as machine `lab`, which names no link.
    const hostile = parseRemoteId('lab/rig/Qwen3-35B')
    assert.equal(hostile?.machine, 'lab')
    const safe = parseRemoteId(`${sanitizeMachineName('lab/rig')}/Qwen3-35B`)
    assert.equal(safe?.machine, 'lab-rig')
    assert.equal(safe?.model, 'Qwen3-35B')
  })

  it('uniquifies against names already taken, case-insensitively', () => {
    assert.equal(uniqueMachineName('rig', []), 'rig')
    assert.equal(uniqueMachineName('rig', ['RIG']), 'rig (2)')
    assert.equal(uniqueMachineName('rig', ['rig', 'rig (2)']), 'rig (3)')
  })
})

function rec(over: Partial<LinkRecord> = {}): LinkRecord {
  return {
    id: 'l1',
    name: 'seed-hostname',
    baseUrl: 'https://rig.example',
    token: 't',
    machineId: null,
    machineIdChanged: false,
    grantedCapabilities: [],
    linkApiVersion: null,
    status: 'unknown',
    lastSeenAt: null,
    lastError: null,
    ...over,
  }
}

const okProbe = (machineName: string) => ({
  kind: 'ok' as const,
  machineId: 'm1',
  capabilities: ['models:use' as const],
  version: 1,
  raw: { machineName },
})

describe('applyProbeResult: a host cannot name itself into local resolution', () => {
  it('strips the separator from an adopted machineName', () => {
    const l = rec()
    applyProbeResult(l, okProbe('lab/rig'))
    assert.equal(l.name, 'lab-rig')
    assert.equal(parseRemoteId(`${l.name}/Qwen3-35B`)?.machine, l.name)
  })

  it('uniquifies an adopted name against the other links', () => {
    const l = rec()
    applyProbeResult(l, okProbe('kaggle'), ['kaggle'])
    assert.equal(l.name, 'kaggle (2)')
  })

  it('leaves a user rename alone on later probes (adoption is first-handshake only)', () => {
    const l = rec({ name: 'my rig', machineId: 'm1' })
    applyProbeResult(l, okProbe('lab/rig'), [])
    assert.equal(l.name, 'my rig')
  })
})
