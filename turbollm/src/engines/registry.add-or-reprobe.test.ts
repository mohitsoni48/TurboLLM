// addOrReprobe() registers a binary a managed install just (re)placed. TurboQuant's update
// reinstalls to the SAME path, so an existing registration must pick up the new build's
// version — otherwise the update check keeps offering the update it just applied.
import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { ConfigStore } from '../config/config'
import { Registry } from './registry'
import { tmpDir } from '../test-support/tmp'

const unix = { skip: process.platform === 'win32' && 'uses a shell-script stand-in for llama-server' }

/** A stand-in llama-server that answers --version like the given build. */
function fakeServer(path: string, versionLine: string): void {
  writeFileSync(path, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "${versionLine}" >&2; fi\nexit 0\n`)
  chmodSync(path, 0o755)
}

test('addOrReprobe: an update to the same path refreshes the stored version, keeping the id', unix, async () => {
  const dir = tmpDir('tllm-reprobe-')
  const binDir = join(dir, 'engines', 'turboquant', 'build', 'bin')
  mkdirSync(binDir, { recursive: true })
  const bin = join(binDir, 'llama-server')
  const reg = new Registry(ConfigStore.load(join(dir, 'config.json')))

  fakeServer(bin, 'version: 1 (519f0c5)') // a build from the fork's per-platform release era
  const first = await reg.addOrReprobe('TurboQuant', bin)
  assert.equal(first.version, '1 (519f0c5)')

  fakeServer(bin, 'version: b10298-2.0.0 (build 11426, commit cda0f9256)') // the update
  const second = await reg.addOrReprobe('TurboQuant', bin)
  assert.equal(second.id, first.id, 'same registration, not a second engine')
  assert.equal(second.version, 'b10298-2.0.0 (build 11426, commit cda0f9256)')
  assert.equal(reg.list().engines.length, 1)
})
