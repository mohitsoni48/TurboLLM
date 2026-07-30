// v3→v4 migration (ADR-299): every existing install already has telemetry.level
// stored as 'off' on disk — not 'unset' — because normalizeTelemetryLevel() has
// coerced any missing/legacy value to 'off' since ADR-041, and TELEMETRY_UI_ENABLED
// was false for the product's entire life until this release, so no human could
// ever have chosen 'off' through the UI. Without this migration, the first-run
// consent card (gated on level === 'unset') would NEVER fire for a single existing
// user — only brand-new installs from this release onward would ever be asked,
// which would cap the whole journey/funnel dataset to future installs only.
//
// Verified against the maintainer's own live config before writing this: a real
// ~/.turbollm/config.json from before this PR reads
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

test('v3→v4: a pre-existing install\'s silently-defaulted "off" is reset to "unset"', () => {
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
    assert.equal(cfg.telemetry.level, 'unset')
  } finally {
    cleanup(path)
  }
})

test('v3→v4: the reset is ONE-SHOT — a real "off" choice made after migration is never re-reset', () => {
  const path = tmpConfigPath()
  try {
    // First load: pre-existing install, migrates 'off' -> 'unset' and persists at v4.
    const v3 = { ...defaultConfig(), version: 3, telemetry: { level: 'off', machineId: '' } }
    writeFileSync(path, JSON.stringify(v3))
    ConfigStore.load(path)

    // The user now sees the consent card for the first time and explicitly
    // chooses Off. The file on disk is already at SCHEMA_VERSION, so this
    // simulates the settings save that follows that real choice.
    const afterConsent = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
    ;(afterConsent.telemetry as { level: string }).level = 'off'
    writeFileSync(path, JSON.stringify(afterConsent))

    // A later load (e.g. next daemon start) must NOT flip this back to 'unset' —
    // migrate() only runs when version < SCHEMA_VERSION, and this file is already
    // current, so the one-shot reset must not re-fire.
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

test('v3→v4: a brand-new install (no file on disk) is untouched by the migration and defaults to "unset"', () => {
  const path = tmpConfigPath() // path does not exist yet — no writeFileSync
  try {
    const cfg = ConfigStore.load(path).snapshot()
    assert.equal(cfg.telemetry.level, 'unset')
    assert.equal(cfg.version, SCHEMA_VERSION)
  } finally {
    cleanup(path)
  }
})

test('v3→v4: an even older config (v2, no telemetry key at all) also gets "unset", not "off"', () => {
  // The v2->v3 migration test fixture has no telemetry key at all. normalize()
  // would otherwise coerce a missing level straight to 'off' — this proves the
  // v3->v4 reset applies to that path too, not just an explicit v3 'off'.
  const path = tmpConfigPath()
  try {
    const v2 = { ...defaultConfig(), version: 2 }
    delete (v2 as Record<string, unknown>).telemetry
    writeFileSync(path, JSON.stringify(v2))

    const cfg = ConfigStore.load(path).snapshot()
    assert.equal(cfg.telemetry.level, 'unset')
  } finally {
    cleanup(path)
  }
})
