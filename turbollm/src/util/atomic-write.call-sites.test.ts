// Each file below is a small piece of persisted state that used to be written in place. Planting a
// DIRECTORY where the helper's temp file would go makes an atomic write fail before it touches the
// target, while a plain in-place write would still succeed: so "previous file untouched" proves the
// call site goes through writeFileAtomicSync.
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { HashStore } from '../models/hashes'
import { claimOnce } from '../telemetry/ledger'
import { recordSent } from '../telemetry/log'
import { persistDailyUsage, recordFeatureUse } from '../telemetry/daily-usage'
import { tmpDir } from '../test-support/tmp'

function blockAtomicWrite(target: string, previous: string): void {
  writeFileSync(target, previous)
  mkdirSync(`${target}.${process.pid}.tmp`)
}

test('telemetry log: a failed atomic write leaves the previous log intact', () => {
  const dir = tmpDir('turbollm-atomic-log-')
  mkdirSync(join(dir, 'telemetry'))
  const file = join(dir, 'telemetry', 'sent.json')
  const event = { schema: 1, event: 'app_first_run', ts: '2026-07-29T12:00:00.000Z' }
  blockAtomicWrite(file, '[]')
  recordSent(dir, [event])
  assert.equal(readFileSync(file, 'utf8'), '[]')
})

test('telemetry ledger: a failed atomic write leaves the previous ledger intact', () => {
  const dir = tmpDir('turbollm-atomic-ledger-')
  mkdirSync(join(dir, 'telemetry'))
  const file = join(dir, 'telemetry', 'ledger.json')
  blockAtomicWrite(file, '["old"]')
  assert.equal(claimOnce(dir, 'new-key'), false)
  assert.equal(readFileSync(file, 'utf8'), '["old"]')
})

test('daily usage: a failed atomic write leaves the previous file intact', () => {
  const dir = tmpDir('turbollm-atomic-usage-')
  mkdirSync(join(dir, 'telemetry'))
  const file = join(dir, 'telemetry', 'daily-usage.json')
  recordFeatureUse(dir, 'chat', '2026-07-29')
  blockAtomicWrite(file, '{"old":{"day":"2026-07-28","count":1}}')
  persistDailyUsage(dir)
  assert.equal(readFileSync(file, 'utf8'), '{"old":{"day":"2026-07-28","count":1}}')
})

test('model hashes: a failed atomic write leaves the previous cache file intact', async () => {
  const dir = tmpDir('turbollm-atomic-hashes-')
  const file = join(dir, 'model-hashes.json')
  const model = join(dir, 'm.gguf')
  writeFileSync(model, 'abc')
  blockAtomicWrite(file, '{"version":1,"entries":{}}')
  const store = new HashStore(dir)
  store.ensure(model, 3, 1)
  for (let i = 0; i < 100 && store.get(model, 3, 1) === undefined; i++) await new Promise((r) => setTimeout(r, 10))
  assert.ok(store.get(model, 3, 1), 'the hash itself was still computed')
  assert.equal(readFileSync(file, 'utf8'), '{"version":1,"entries":{}}')
})
