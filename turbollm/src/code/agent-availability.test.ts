// installAgent runs a harness's install command (`npm install -g …`, up to 180 s) in the daemon;
// nothing aborts it when the page that asked for it closes. Its one-per-id guard was claimed only
// after two dynamic imports, so a double click on Install passed the check twice and ran two
// `npm install -g` side by side, and a page reloaded mid-install had no way to learn one was
// running: it offered Install again, which then failed with "already running". A second call now
// joins the running install, and agentAvailability (GET /api/v1/code/agents) reports `installing`.
// The child process is a fake handed in through installAgent's `_spawn` seam. Each test that starts
// an install is bounded, so a caller left waiting on a child nobody closes fails the test instead of
// hanging the file, and cuts that install's own time limit to 5 s so its timer cannot hold the
// process for 180 s. (The unknown-id test returns before anything is spawned.) Every
// agentAvailability call gets a fake `<bin> --version` too: the real probe runs each harness's CLI,
// and pi's is on PATH wherever `npm test` runs (it is this package's dependency, and npm puts
// node_modules/.bin there). Under load that can outlast the install's 5 s limit, whose timer then
// ends the install before `installing` is read.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { EventEmitter } from 'node:events'
import type { spawn } from 'node:child_process'
import { agentAvailability, installAgent, invalidateAvailabilityCache } from './agent-availability'

type FakeChild = EventEmitter & { stderr: EventEmitter; kill: () => void }

function fakeSpawner() {
  const children: FakeChild[] = []
  const run = (() => {
    const child = new EventEmitter() as FakeChild
    child.stderr = new EventEmitter()
    child.kill = () => {}
    children.push(child)
    return child
  }) as unknown as typeof spawn
  return { run, children }
}

const tick = () => new Promise((r) => setTimeout(r, 50))
const noCli = async () => false
const installingOf = async (id: string) => (await agentAvailability(Date.now, noCli)).find((a) => a.id === id)?.installing

test('two installs of one agent started together run its install command once and share its result', { timeout: 10_000 }, async () => {
  const { run, children } = fakeSpawner()
  const first = installAgent('claude', run, 5_000)
  const second = installAgent('claude', run, 5_000)
  await tick()
  assert.equal(children.length, 1, 'one npm process, not two')
  assert.equal(await installingOf('claude'), true, 'GET /code/agents reports it installing')
  assert.equal(await installingOf('pi'), false, 'and only that agent')

  children[0].emit('close', 0)
  assert.deepEqual(await first, { ok: true })
  assert.deepEqual(await second, { ok: true }, 'the second call gets the same result, not "already running"')
  assert.equal(await installingOf('claude'), false, 'no longer installing once it settled')
})

test('an install asked for while one runs joins it, and a failure reaches both callers', { timeout: 10_000 }, async () => {
  const { run, children } = fakeSpawner()
  const first = installAgent('opencode', run, 5_000)
  await tick() // the install is running, as when a reloaded page asks again
  const joined = installAgent('opencode', run, 5_000)
  await tick()
  assert.equal(children.length, 1)

  children[0].stderr.emit('data', Buffer.from('npm ERR! code EACCES\n'))
  children[0].emit('close', 1)
  const expected = { ok: false, message: 'npm ERR! code EACCES' }
  assert.deepEqual(await first, expected)
  assert.deepEqual(await joined, expected)
})

test('once an install has settled, the next one runs its command again', { timeout: 10_000 }, async () => {
  const { run, children } = fakeSpawner()
  const first = installAgent('pi', run, 5_000)
  await tick()
  children[0].emit('close', 1)
  assert.equal((await first).ok, false)

  const retry = installAgent('pi', run, 5_000)
  await tick()
  assert.equal(children.length, 2, 'a retry after a failure is a new install')
  children[1].emit('close', 0)
  assert.deepEqual(await retry, { ok: true })
})

test('an id the picker does not offer is refused, and nothing is started', async () => {
  const { run, children } = fakeSpawner()
  assert.deepEqual(await installAgent('kilo', run), { ok: false, message: 'Unknown coding agent "kilo".' })
  assert.equal(children.length, 0)
})

test('a probe still running when an install ends neither answers nor caches what it saw before', { timeout: 10_000 }, async () => {
  invalidateAvailabilityCache()
  const { run, children } = fakeSpawner()
  const install = installAgent('opencode', run, 5_000)
  await tick()
  // A slow `pi --version` keeps the probe running past the end of the install; `opencode
  // --version` has already answered that it is missing.
  let opencodeOnPath = false
  let answerPi!: () => void
  const piAnswers = new Promise<void>((r) => { answerPi = r })
  const probe = async (bin: string) => {
    if (bin === 'pi') await piAnswers
    return bin === 'opencode' && opencodeOnPath
  }
  const polled = agentAvailability(Date.now, probe) // a page polling while the install runs
  await tick()

  opencodeOnPath = true
  children[0].emit('close', 0)
  assert.deepEqual(await install, { ok: true })
  answerPi()
  const answer = (await polled).find((a) => a.id === 'opencode')
  assert.deepEqual([answer?.installed, answer?.installing], [true, false], 'not "missing, and no longer installing", on which a poll stops')
  const next = (await agentAvailability(Date.now, probe)).find((a) => a.id === 'opencode')
  assert.equal(next?.installed, true, 'and the next request does not get it from the cache')
})
