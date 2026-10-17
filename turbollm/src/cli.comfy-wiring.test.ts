// Source-level guard for the ComfyUI guard's wiring in cli.ts. cli.ts is top-level module code that boots the real
// daemon when imported, so it cannot be loaded from a test (see cli.lifecycle-wiring.test.ts). The behaviour is tested
// in gateway/model-router.comfy-reload.test.ts, against a real guard and router wired the same way.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const CLI = readFileSync(join(HERE, 'cli.ts'), 'utf8')

test("the ComfyUI guard's reload after a render runs under the gateway router's swap lock", () => {
  assert.ok(CLI.includes('comfy.setSwapLock((fn) => modelRouter.withSwapLock(fn))'))
})

test("the ComfyUI guard's reload after a render checks its engine is still in the registry", () => {
  assert.ok(CLI.includes('comfy.setEngineLookup((id) => registry.get(id))'))
})

test("the ComfyUI guard's reload after a render tells the gateway router which model it brought up", () => {
  assert.ok(CLI.includes('comfy.setOnReloaded((modelKey, engineId) => modelRouter.reloadedAfterRender(modelKey, engineId))'))
})
