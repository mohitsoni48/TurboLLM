// BuildState.get() is GET /status `engineBuild`. The web UI tells a build from source (during which the daemon
// refuses to add, enable, disable or delete an engine) from a CUDA Toolkit download or a prerequisite install by its
// toolInstall: it went by the label, and a build the user named "cuda", "git", "cmake" or "gcc" was taken for a tool
// install, so the Engines screen left open the actions the daemon refused on every click.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BuildState } from './build-state'

test('BuildState.get(): says whether the run is a tool install, whatever its label, through to its end', () => {
  const b = new BuildState()
  assert.equal(b.get().toolInstall, false)
  b.start('cuda') // a build from source the user named "cuda"
  assert.equal(b.get().toolInstall, false)
  assert.equal(b.isEngineBuildActive(), true)
  b.done()
  assert.equal(b.get().toolInstall, false)

  b.start('cuda', { toolInstall: true }) // the build guide's CUDA prerequisite install
  assert.equal(b.get().toolInstall, true)
  assert.equal(b.isEngineBuildActive(), false)
  b.fail('apt-get exited with code 100')
  assert.deepEqual([b.get().phase, b.get().toolInstall], ['error', true], 'its end still says what it was')
})
