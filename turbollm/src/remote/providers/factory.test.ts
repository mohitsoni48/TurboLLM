import test from 'node:test'
import assert from 'node:assert/strict'
import type { Deps } from '../../deps'
import { makeProvider } from './factory'
import { defaultConfig, REMOTE_PROVIDERS } from '../../config/config'

const deps = (): Deps => {
  const cfg = defaultConfig()
  return { store: { snapshot: () => cfg, dir: () => '/tmp/data' } } as unknown as Deps
}

test('factory: every declared provider id resolves to a provider with that id', () => {
  for (const id of REMOTE_PROVIDERS) {
    assert.equal(makeProvider(id, deps()).id, id, `factory did not wire ${id}`)
  }
})

test('factory: every provider declares a known lifecycle', () => {
  for (const id of REMOTE_PROVIDERS) {
    assert.equal(['child-process', 'system-state', 'none'].includes(makeProvider(id, deps()).lifecycle), true)
  }
})
