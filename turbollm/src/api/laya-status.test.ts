// `layaStatus()` tells the UI which Laya model is alive, so the System One playground can run against it. Unlike
// a Jev model, a Laya model never takes the Workspace over: it runs beside the chat model.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { layaStatus } from './laya-status'
import type { Deps } from '../deps'
import type { AliveSlot } from '../gateway/model-router'
import type { ModelEntry } from '../models/scanner'

const LAYA = { key: 'laya|laya|1455', name: 'laya', laya: { checkpoints: ['english', 'multilingual'] } }
const LAYA_OLD = { key: 'laya old|laya|1400', name: 'laya old', laya: { checkpoints: ['english'] } }
const CHAT = { key: 'gemma 4 e4b|Q6_K|6217256480', name: 'Gemma 4 E4B' }

function depsWith(slots: AliveSlot[]): Deps {
  const library = new Map([LAYA, LAYA_OLD, CHAT].map((m) => [m.key, m as unknown as ModelEntry]))
  return {
    modelRouter: { aliveSlots: () => slots },
    scanner: { get: (key: string) => library.get(key) },
  } as unknown as Deps
}

function slot(modelKey: string, overrides: Partial<AliveSlot> = {}): AliveSlot {
  return { modelKey, state: 'running', primary: false, lastUsedMs: 0, ...overrides }
}

test('an alive Laya pool slot is reported beside a chat primary', () => {
  const status = layaStatus(depsWith([slot(CHAT.key, { primary: true }), slot(LAYA.key)]))
  assert.deepEqual(status, { key: LAYA.key, name: LAYA.name, checkpoints: ['english', 'multilingual'], state: 'running' })
})

test('a starting Laya model is reported as starting', () => {
  assert.equal(layaStatus(depsWith([slot(LAYA.key, { state: 'starting' })]))?.state, 'starting')
})

test('with two Laya models alive, the most recently used one is reported', () => {
  const status = layaStatus(depsWith([slot(LAYA_OLD.key, { lastUsedMs: 900 }), slot(LAYA.key, { lastUsedMs: 100 })]))
  assert.equal(status?.key, LAYA_OLD.key)
})

test('no Laya model alive is null, whatever else is loaded', () => {
  assert.equal(layaStatus(depsWith([slot(CHAT.key, { primary: true })])), null)
  assert.equal(layaStatus(depsWith([])), null)
})
