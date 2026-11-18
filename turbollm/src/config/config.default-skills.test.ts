// Skills switched on for every new chat (Skills library → "On by default"): the daemon keeps their ids in
// config.defaultSkillIds. Loaded through ConfigStore.load on a real temp file so migrate() and normalize() run, and
// patched through the settings table the PATCH route is built on.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ConfigStore, defaultConfig } from './config'
import { Refusal, parseSettingsPatch, settingsView } from './settings-schema'
import { tmpDir } from '../test-support/tmp'

function loadRaw(raw: unknown) {
  const path = join(tmpDir('tllm-default-skills-cfg-'), 'config.json')
  writeFileSync(path, JSON.stringify(raw), 'utf8')
  return ConfigStore.load(path).snapshot()
}

test('a config written before default skills existed loads with none on by default', () => {
  const { defaultSkillIds, ...older } = defaultConfig()
  void defaultSkillIds
  assert.deepEqual(loadRaw(older).defaultSkillIds, [])
})

test('a hand-edited list keeps each non-empty id once, in order, and drops the rest', () => {
  assert.deepEqual(loadRaw({ defaultSkillIds: ['web', '', 7, null, 'code', 'web'] }).defaultSkillIds, ['web', 'code'])
  assert.deepEqual(loadRaw({ defaultSkillIds: 'web' }).defaultSkillIds, [])
})

test('PATCH defaultSkillIds stores the trimmed list and settingsView reads it back', () => {
  const parsed = parseSettingsPatch({ defaultSkillIds: [' web ', 'code'] }, { stored: defaultConfig() })
  assert.ok(!(parsed instanceof Refusal))
  const after = structuredClone(defaultConfig())
  parsed.apply(after)
  assert.deepEqual(after.defaultSkillIds, ['web', 'code'])
  assert.deepEqual(settingsView(after).defaultSkillIds, ['web', 'code'])
})

test('PATCH defaultSkillIds refuses anything that is not a list of strings', () => {
  for (const bad of ['web', [1], null, { a: 1 }]) {
    const r = parseSettingsPatch({ defaultSkillIds: bad }, { stored: defaultConfig() })
    assert.ok(r instanceof Refusal, JSON.stringify(bad))
    assert.equal(r.status, 400)
  }
})
