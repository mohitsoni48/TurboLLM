import { test } from 'node:test'
import assert from 'node:assert/strict'
import { formatRemoteId, parseRemoteId, isQualifiedId } from './model-id'

test('formats and parses a simple id', () => {
  assert.equal(formatRemoteId('workstation', 'Qwen3-35B'), 'workstation/Qwen3-35B')
  assert.deepEqual(parseRemoteId('workstation/Qwen3-35B'), { machine: 'workstation', model: 'Qwen3-35B' })
})

test('a model key containing slashes survives — HF keys look like owner/repo/file', () => {
  // The single most likely way a naive split('/') implementation breaks in production.
  const id = formatRemoteId('workstation', 'unsloth/Qwen3-35B-GGUF/Q4_K_M.gguf')
  assert.deepEqual(parseRemoteId(id), {
    machine: 'workstation', model: 'unsloth/Qwen3-35B-GGUF/Q4_K_M.gguf',
  })
})

test('a bare local id is NOT qualified', () => {
  assert.equal(isQualifiedId('Qwen3-35B'), false)
  assert.equal(parseRemoteId('Qwen3-35B'), null)
})

test('a leading or trailing slash is not a qualified id', () => {
  assert.equal(parseRemoteId('/Qwen3-35B'), null)
  assert.equal(parseRemoteId('workstation/'), null)
})

test('an empty string is not a qualified id', () => {
  assert.equal(parseRemoteId(''), null)
  assert.equal(isQualifiedId(''), false)
})

test('machine names are matched case-insensitively but preserved as typed', () => {
  const p = parseRemoteId('Workstation/Qwen3')
  assert.equal(p!.machine, 'Workstation')
})

test('a machine name with a space round-trips', () => {
  assert.deepEqual(parseRemoteId(formatRemoteId('gaming rig', 'Qwen3')), {
    machine: 'gaming rig', model: 'Qwen3',
  })
})
