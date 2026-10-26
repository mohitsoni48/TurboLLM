import test from 'node:test'
import assert from 'node:assert/strict'
import type { Deps } from '../deps'
import { clearEnabledWhileFlagOff, isRemoteAccessEnabled, REMOTE_DISABLED } from './gate'
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

// A config booted with the flag off and `enabled: true` (older builds' flag-off, or a hand edit)
// kept it: turning the flag on then left remote access reading off in the UI, while the next
// restart auto-started the saved provider with no click.
test('gate: boot clears a leftover remoteAccess.enabled only while the flag is off', () => {
  const store = (flag: boolean, enabled: boolean) => {
    const cfg = defaultConfig()
    cfg.daemon.experimental.remoteAccess = flag
    cfg.remoteAccess.enabled = enabled
    return { cfg, d: { store: { snapshot: () => cfg, update: (fn: (c: typeof cfg) => void) => fn(cfg) } } as unknown as Deps }
  }
  const off = store(false, true)
  assert.equal(clearEnabledWhileFlagOff(off.d), true)
  assert.equal(off.cfg.remoteAccess.enabled, false)
  const on = store(true, true) // the flag on: the boot auto-start owns it
  assert.equal(clearEnabledWhileFlagOff(on.d), false)
  assert.equal(on.cfg.remoteAccess.enabled, true)
  assert.equal(clearEnabledWhileFlagOff(store(false, false).d), false)
})

test('gate: the disabled error is typed and distinct', () => {
  assert.equal(REMOTE_DISABLED.error.code, 'remote_access_disabled')
})
