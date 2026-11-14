// Manager.hold: work that needs the engine between its requests (a one-shot CLI routine) keeps it from being idle
// without being a generation, so the engine card does not show it as generating.
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { test } from 'node:test'
import { ConfigStore } from '../config/config'
import { Manager } from './manager'
import { tmpDir } from '../test-support/tmp'

function manager(): Manager {
  return new Manager(ConfigStore.load(join(tmpDir('tllm-hold-'), 'config.json')))
}

test('a hold reads as held without raising the generation count, and its release is idempotent', () => {
  const m = manager()
  assert.equal(m.isHeld(), false)
  const release = m.hold()
  const other = m.hold()
  assert.equal(m.isHeld(), true)
  assert.equal(m.sessionStats().activeRequests, 0)
  release()
  release()
  assert.equal(m.isHeld(), true, 'the second hold is still in place: a double release frees only its own')
  other()
  assert.equal(m.isHeld(), false)
})

test('between two requests of a held run, the engine card shows no live generation', () => {
  const m = manager()
  const release = m.hold()
  m.generationStart()
  m.setLiveGen({ phase: 'gen', pct: 0, outputTokens: 12 })
  assert.notEqual(m.liveGeneration(), null)
  m.generationEnd()
  assert.equal(m.liveGeneration(), null)
  assert.equal(m.isHeld(), true)
  release()
})

test('hasHolds sees only hold(), not the chat work holdsEngine reports (a parked approval is not active work)', () => {
  const m = manager()
  m.holdsEngine = () => true
  assert.equal(m.hasHolds(), false, 'a chat hold is isHeld(), never hasHolds()')
  const release = m.hold()
  assert.equal(m.hasHolds(), true)
  release()
  assert.equal(m.hasHolds(), false)
})
