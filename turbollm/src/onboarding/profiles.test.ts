import test from 'node:test'
import assert from 'node:assert/strict'
import { BLESSED } from './models'
import { roleFor } from './profiles'

test('roleFor: pro resolves no role — it takes the Discover handoff', () => {
  assert.equal(roleFor('pro'), null)
  assert.equal(roleFor('casual'), 'general')
  assert.equal(roleFor('enthusiast'), 'general')
  assert.equal(roleFor('developer'), 'coder')
})

test('BLESSED: no entry references an mmproj or MTP file', () => {
  for (const e of BLESSED) {
    assert.ok(!e.file.includes('mmproj'), `${e.id} must not use an mmproj file`)
    assert.ok(!/(^|[-/])mtp/i.test(e.file), `${e.id} must not use an MTP file`)
    assert.ok(!/-MTP-GGUF/i.test(e.repo), `${e.id} must not use an MTP repo`)
  }
})

test('BLESSED: every entry id is unique', () => {
  const ids = BLESSED.map((e) => e.id)
  assert.equal(new Set(ids).size, ids.length)
})

test('BLESSED: sizes match the figures verified against the HF API on 2026-08-06', () => {
  const byId = Object.fromEntries(BLESSED.map((e) => [e.id, e.bytes]))
  assert.equal(byId['G-T2'], 7_121_861_440)
  assert.equal(byId['C-LOW-B'], 16_845_511_648)
  assert.equal(byId['T0-A'], 4_977_171_584)
})
