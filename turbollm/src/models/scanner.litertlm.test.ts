import assert from 'node:assert/strict'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { defaultConfig, type Config, type ConfigStore } from '../config/config'
import { Scanner } from './scanner'
import { tmpDir } from '../test-support/tmp'

function scannerOver(t: TestContext): { library: string; scanner: Scanner } {
  const root = tmpDir('turbollm-litertlm-scan-')
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const library = join(root, 'library')
  const data = join(root, 'data')
  mkdirSync(library)
  mkdirSync(data)
  const cfg: Config = { ...defaultConfig(), modelDirs: [library] }
  const store = { dir: () => data, snapshot: () => cfg, update: (fn: (c: Config) => void) => fn(cfg) }
  return { library, scanner: new Scanner(store as unknown as ConfigStore) }
}

const bundle = (extra = 32) => Buffer.concat([Buffer.from('LITERTLM'), Buffer.alloc(extra)])

test('a .litertlm file with the LiteRT-LM magic is discovered as one model', async (t) => {
  const { library, scanner } = scannerOver(t)
  const file = join(library, 'gemma-3n-E2B-it-int4.litertlm')
  writeFileSync(file, bundle())
  await scanner.rescan()
  const models = scanner.list().models
  assert.equal(models.length, 1)
  assert.equal(models[0].format, 'litertlm')
  assert.equal(models[0].path, file)
  assert.equal(models[0].quant, 'INT4')
})

test('a .litertlm file without the magic (an error page, a truncated download) is ignored', async (t) => {
  const { library, scanner } = scannerOver(t)
  writeFileSync(join(library, 'fake.litertlm'), '<html>Access denied</html>')
  await scanner.rescan()
  assert.equal(scanner.list().models.length, 0)
})

test('a .litertlm in a subfolder is found and does not disturb neighbouring models', async (t) => {
  const { library, scanner } = scannerOver(t)
  mkdirSync(join(library, 'litert-community', 'qwen'), { recursive: true })
  writeFileSync(join(library, 'litert-community', 'qwen', 'Qwen3-0.6B_q8_ekv4096.litertlm'), bundle())
  writeFileSync(join(library, 'notes.txt'), 'hello')
  await scanner.rescan()
  const models = scanner.list().models
  assert.equal(models.length, 1)
  assert.equal(models[0].format, 'litertlm')
  assert.equal(models[0].nativeCtx, 4096)
})
