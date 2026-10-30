import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { RESTART_REQUESTED_EXIT_CODE, planRestartExit } from './daemon-restart'

const HERE = dirname(fileURLToPath(import.meta.url))
const NODE_RESERVED_EXIT_CODES = [0, 1, 3, 4, 5, 6, 7, 9, 10, 12, 13]
const FIRST_SIGNAL_EXIT_CODE = 128

test('the restart exit code is 75, outside Node\'s reserved exit codes and below the signal range', () => {
  assert.equal(RESTART_REQUESTED_EXIT_CODE, 75)
  assert.ok(!NODE_RESERVED_EXIT_CODES.includes(RESTART_REQUESTED_EXIT_CODE))
  assert.ok(RESTART_REQUESTED_EXIT_CODE < FIRST_SIGNAL_EXIT_CODE)
})

test('planRestartExit: an unsupervised (npm/CLI, Docker) restart makes this process the keeper of its replacement', () => {
  assert.deepEqual(
    planRestartExit({ exitOnly: false, supervised: false }),
    { kind: 'become-keeper', exitCode: 0 },
  )
})

test('planRestartExit: a supervised restart (the desktop app, or a keeper) exits 75 and spawns nothing itself', () => {
  assert.deepEqual(
    planRestartExit({ exitOnly: false, supervised: true }),
    { kind: 'supervisor-respawn', exitCode: 75 },
  )
})

test('planRestartExit: exitOnly wins, supervised or not', () => {
  for (const supervised of [false, true]) {
    assert.deepEqual(
      planRestartExit({ exitOnly: true, supervised }),
      { kind: 'exit-only', exitCode: 0 },
      `supervised: ${supervised}`,
    )
  }
})

test('daemon-restart.ts never reads the environment itself (util/boot-env.ts binds supervision at boot)', () => {
  const source = readFileSync(join(HERE, 'daemon-restart.ts'), 'utf8')
  assert.ok(!source.includes('process.env'), 'daemon-restart.ts must never read process.env itself')
})
