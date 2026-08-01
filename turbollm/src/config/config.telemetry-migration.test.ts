// v3→v4 migration (ADR-299, revised by the ADR-299-Decision-4 supersession on
// 2026-08-01): every existing install already has telemetry.level stored as 'off'
// on disk because normalizeTelemetryLevel() has coerced any missing/legacy value
// to 'off' since ADR-041, and TELEMETRY_UI_ENABLED was false for the product's
// entire life until ADR-299 shipped, so no human could ever have chosen 'off'
// through the UI. That makes it a synthetic default, not a real choice — this
// migration bumps it to the new default ('full') instead of leaving these
// installs stuck opted-out forever with no consent card left to ever ask them.
//
// Verified against the maintainer's own live config before writing the original
// version of this test: a real ~/.turbollm/config.json from before that PR reads
// `"telemetry": { "level": "off", "machineId": "" }`.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConfigStore, SCHEMA_VERSION, defaultConfig } from './config'

function tmpConfigPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'tllm-cfg-telemetry-'))
  return join(dir, 'config.json')
}

function cleanup(path: string): void {
  rmSync(join(path, '..'), { recursive: true, force: true })
}

test('SCHEMA_VERSION bumped for the telemetry-consent migration', () => {
  assert.equal(SCHEMA_VERSION, 4)
})

test('v3→v4: a pre-existing install\'s silently-defaulted "off" is bumped to "full"', () => {
  const path = tmpConfigPath()
  try {
    const v3 = {
      ...defaultConfig(),
      version: 3,
      telemetry: { level: 'off', machineId: '' },
    }
    writeFileSync(path, JSON.stringify(v3))

    const cfg = ConfigStore.load(path).snapshot()

    assert.equal(cfg.version, SCHEMA_VERSION)
    assert.equal(cfg.telemetry.level, 'full')
  } finally {
    cleanup(path)
  }
})

test('v3→v4: the bump is ONE-SHOT — a real "off" choice made after migration is never re-bumped', () => {
  const path = tmpConfigPath()
  try {
    // First load: pre-existing install, migrates 'off' -> 'full' and persists at v4.
    const v3 = { ...defaultConfig(), version: 3, telemetry: { level: 'off', machineId: '' } }
    writeFileSync(path, JSON.stringify(v3))
    ConfigStore.load(path)

    // The user now visits Settings and explicitly chooses Off. The file on disk
    // is already at SCHEMA_VERSION, so this simulates the settings save that
    // follows that real choice.
    const afterChoice = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
    ;(afterChoice.telemetry as { level: string }).level = 'off'
    writeFileSync(path, JSON.stringify(afterChoice))

    // A later load (e.g. next daemon start) must NOT flip this back to 'full' —
    // migrate() only runs when version < SCHEMA_VERSION, and this file is already
    // current, so the one-shot bump must not re-fire.
    const cfg = ConfigStore.load(path).snapshot()
    assert.equal(cfg.telemetry.level, 'off')
  } finally {
    cleanup(path)
  }
})

test('v3→v4: an old config already at "anon" or "full" is never touched by the reset', () => {
  // Belt-and-suspenders: the reset must only ever act on 'off', never on real
  // engagement, even though no pre-existing config can currently hold these
  // values (the UI to set them didn't exist before this release).
  for (const level of ['anon', 'full']) {
    const path = tmpConfigPath()
    try {
      const v3 = { ...defaultConfig(), version: 3, telemetry: { level, machineId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' } }
      writeFileSync(path, JSON.stringify(v3))

      const cfg = ConfigStore.load(path).snapshot()
      assert.equal(cfg.telemetry.level, level)
      assert.equal(cfg.telemetry.machineId, 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee')
    } finally {
      cleanup(path)
    }
  }
})

test('v3→v4: a brand-new install (no file on disk) is untouched by the migration and defaults to "full"', () => {
  const path = tmpConfigPath() // path does not exist yet — no writeFileSync
  try {
    const cfg = ConfigStore.load(path).snapshot()
    assert.equal(cfg.telemetry.level, 'full')
    assert.equal(cfg.version, SCHEMA_VERSION)
  } finally {
    cleanup(path)
  }
})

test('v3→v4: an even older config (v2, no telemetry key at all) also gets "full", not "off"', () => {
  // The v2->v3 migration test fixture has no telemetry key at all. normalize()
  // would otherwise coerce a missing level straight to 'off' — this proves the
  // new default applies to that path too, not just an explicit v3 'off'.
  const path = tmpConfigPath()
  try {
    const v2 = { ...defaultConfig(), version: 2 }
    delete (v2 as Record<string, unknown>).telemetry
    writeFileSync(path, JSON.stringify(v2))

    const cfg = ConfigStore.load(path).snapshot()
    assert.equal(cfg.telemetry.level, 'full')
  } finally {
    cleanup(path)
  }
})
