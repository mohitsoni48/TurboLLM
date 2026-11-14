import test from 'node:test'
import assert from 'node:assert/strict'
import type { Deps } from '../deps'
import { isSandboxEnabled, SANDBOX_DISABLED, SANDBOX_UNSUPPORTED, sandboxSupported } from './gate'
import { defaultConfig } from '../config/config'

const depsWith = (sandbox: unknown): Deps => {
  const cfg = defaultConfig()
  ;(cfg.daemon.experimental as unknown as Record<string, unknown>).sandbox = sandbox
  return { store: { snapshot: () => cfg, read: () => cfg } } as unknown as Deps
}

test('gate: off by default', () => {
  assert.equal(isSandboxEnabled(depsWith(false), 'linux'), false)
  assert.equal(defaultConfig().daemon.experimental.sandbox, false)
})

test('gate: on only for a literal true', () => {
  assert.equal(isSandboxEnabled(depsWith(true), 'linux'), true)
  assert.equal(isSandboxEnabled(depsWith('true'), 'linux'), false)
  assert.equal(isSandboxEnabled(depsWith(1), 'linux'), false)
})

test('gate: fails closed on a config with no experimental block at all', () => {
  const d = { store: { snapshot: () => ({ daemon: {} }), read: () => ({ daemon: {} }) } } as unknown as Deps
  assert.equal(isSandboxEnabled(d, 'linux'), false)
})

test('gate: off on Android even with the flag on', () => {
  assert.equal(isSandboxEnabled(depsWith(true), 'android'), false)
  assert.equal(sandboxSupported('android'), false)
  for (const p of ['win32', 'darwin', 'linux'] as const) assert.equal(sandboxSupported(p), true)
})

test('gate: refusals are typed codes, not 404s', () => {
  assert.equal(SANDBOX_DISABLED.error.code, 'sandbox_disabled')
  assert.equal(SANDBOX_UNSUPPORTED.error.code, 'sandbox_unsupported')
})
