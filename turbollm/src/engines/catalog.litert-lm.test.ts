import { test } from 'node:test'
import assert from 'node:assert/strict'
import { catalogEngine, catalogForPlatform } from './catalog'
import { evaluateVariant } from './compat'

test('the catalog lists LiteRT-LM as an experimental pip engine installed through its own endpoint', () => {
  const e = catalogEngine('litert-lm')
  assert.ok(e, 'no litert-lm catalog entry')
  assert.equal(e.kind, 'litert-lm')
  assert.equal(e.provision, 'pip')
  assert.equal(e.support, 'experimental')
  assert.equal(e.repo, 'google-ai-edge/LiteRT-LM')
  assert.equal(e.installEndpoint, '/api/v1/engines/litert-lm')
})

test('every LiteRT-LM variant is experimental, so none can become the headline recommendation', () => {
  const e = catalogEngine('litert-lm')!
  const variants = e.variants ?? []
  assert.equal(variants.length, 4)
  for (const v of variants) {
    assert.equal(v.stability, 'experimental', v.id)
    assert.equal(v.hasPrebuilt, true, v.id)
    assert.equal(v.speed, 'fast', v.id)
  }
})

test('LiteRT-LM is listed on desktop platforms and on Android', () => {
  for (const platform of ['win32', 'darwin', 'linux', 'android'] as const) {
    assert.equal(catalogForPlatform(platform).find((e) => e.id === 'litert-lm')?.supportedHere, true, platform)
  }
  assert.equal(catalogForPlatform('android').some((e) => e.id === 'litert-lm'), true)
})

test('variants match exactly the platform/arch pairs that have a wheel', () => {
  const e = catalogEngine('litert-lm')!
  const variants = e.variants ?? []
  const fits = (platform: string, arch: string) =>
    variants.some((v) => evaluateVariant({ platform, arch, gpus: [] } as never, v.requires).ok)
  assert.equal(fits('win32', 'x64'), true)
  assert.equal(fits('linux', 'x64'), true)
  assert.equal(fits('linux', 'arm64'), true)
  assert.equal(fits('darwin', 'arm64'), true)
  assert.equal(fits('android', 'arm64'), true)
  assert.equal(fits('android', 'x64'), true)
  assert.equal(fits('android', 'arm'), false)
  assert.equal(fits('linux', 'arm'), false)
  assert.equal(fits('darwin', 'x64'), false)
  assert.equal(fits('win32', 'arm64'), false)
})
