import test from 'node:test'
import assert from 'node:assert/strict'
import type { Deps } from '../deps'
import { isRemoteAccessEnabled, REMOTE_DISABLED } from './gate'
import { defaultConfig } from '../config/config'

const depsWith = (remoteAccess: unknown): Deps => {
  const cfg = defaultConfig()
  ;(cfg.daemon.experimental as unknown as Record<string, unknown>).remoteAccess = remoteAccess
  return { store: { snapshot: () => cfg } } as unknown as Deps
}

test('gate: off by default', () => {
  assert.equal(isRemoteAccessEnabled({ store: { snapshot: () => defaultConfig() } } as unknown as Deps), false)
})

test('gate: on only for a literal true', () => {
  assert.equal(isRemoteAccessEnabled(depsWith(true)), true)
  assert.equal(isRemoteAccessEnabled(depsWith('true')), false)
  assert.equal(isRemoteAccessEnabled(depsWith(1)), false)
})

test('gate: fails closed on a config with no experimental block at all', () => {
  const d = { store: { snapshot: () => ({ daemon: {} }) } } as unknown as Deps
  assert.equal(isRemoteAccessEnabled(d), false)
})

test('gate: the disabled error is typed and distinct', () => {
  assert.equal(REMOTE_DISABLED.error.code, 'remote_access_disabled')
})
