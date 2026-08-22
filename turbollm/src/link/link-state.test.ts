import { test } from 'node:test'
import assert from 'node:assert/strict'
import { nextStatus, describeStatus } from './link-state'

const ok = { kind: 'ok' as const, machineId: 'm', capabilities: [], version: 1 }
const net = { kind: 'network' as const }
const http401 = { kind: 'http' as const, status: 401 }
const http500 = { kind: 'http' as const, status: 500 }
const incompat = { kind: 'incompatible' as const, theirVersions: [9] }

test('a successful probe means online, from any prior state', () => {
  for (const s of ['unknown', 'unreachable', 'revoked', 'incompatible', 'online'] as const) {
    assert.equal(nextStatus(s, ok), 'online')
  }
})

test('a network failure means unreachable', () => {
  assert.equal(nextStatus('online', net), 'unreachable')
})

test('a 401 means revoked', () => {
  assert.equal(nextStatus('online', http401), 'revoked')
})

// ── ADR-144's latch, the exact bug that wiped a half-typed API key on a real Wi-Fi LAN.
test('revoked LATCHES through network failures — only a successful probe clears it', () => {
  assert.equal(nextStatus('revoked', net), 'revoked')
  assert.equal(nextStatus('revoked', net), 'revoked')
  assert.equal(nextStatus('revoked', ok), 'online')
})

test('a raw network failure never fabricates revoked, however many times it repeats', () => {
  let s = nextStatus('unknown', net)
  for (let i = 0; i < 20; i++) s = nextStatus(s, net)
  assert.equal(s, 'unreachable')
})

test('a non-401 HTTP error is unreachable, not revoked — a 500 is the host being broken, not a withdrawn grant', () => {
  assert.equal(nextStatus('online', http500), 'unreachable')
  assert.equal(nextStatus('online', { kind: 'http', status: 502 }), 'unreachable')
})

test('a 403 is NOT revoked — the token is valid, one capability is missing', () => {
  assert.equal(nextStatus('online', { kind: 'http', status: 403 }), 'online')
})

test('an incompatible probe means incompatible, and does not latch over a later success', () => {
  assert.equal(nextStatus('online', incompat), 'incompatible')
  assert.equal(nextStatus('incompatible', ok), 'online')
})

test('describeStatus names the machine so the message is actionable', () => {
  assert.match(describeStatus('unreachable', 'workstation'), /workstation/)
  assert.match(describeStatus('revoked', 'workstation'), /revoked/i)
  assert.match(describeStatus('incompatible', 'workstation'), /update/i)
})
