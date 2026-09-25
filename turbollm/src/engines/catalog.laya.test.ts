import { test } from 'node:test'
import assert from 'node:assert/strict'
import { catalogEngine, catalogForPlatform } from './catalog'

test('the catalog lists Laya as a pip engine installed through its own endpoint', () => {
  const laya = catalogEngine('laya')
  assert.ok(laya, 'no laya catalog entry')
  assert.equal(laya.kind, 'laya')
  assert.equal(laya.provision, 'pip')
  assert.equal(laya.installEndpoint, '/api/v1/engines/laya')
  assert.equal(laya.homepage, 'https://github.com/NandhaKishorM/laya')
})

test('Laya is supported on every desktop platform, and not on Android', () => {
  for (const platform of ['win32', 'darwin', 'linux'] as const) {
    assert.equal(catalogForPlatform(platform).find((e) => e.id === 'laya')?.supportedHere, true, platform)
  }
  assert.equal(catalogForPlatform('android').some((e) => e.id === 'laya'), false)
})
