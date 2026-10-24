import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isCliAvailable, isClaudeCliAvailable, VERSION_PROBE_DEADLINE_MS } from './cli-preflight'

test('reports available when the probe command exits 0', async () => {
  const fakeRun = async (bin: string, args: string[]) => {
    assert.equal(bin, 'claude')
    assert.deepEqual(args, ['--version'])
    return true
  }
  assert.equal(await isClaudeCliAvailable(fakeRun), true)
})

test('reports unavailable when the probe command fails (not installed / ENOENT)', async () => {
  const fakeRun = async () => false
  assert.equal(await isClaudeCliAvailable(fakeRun), false)
})

// The probe had no deadline: a `claude --version` that never answered held the Routines preflight and GET
// /api/v1/code/agents for good. The run's end at the deadline is realRunCommandWithin's (agent-availability.tether.test.ts).
test('a probe that has not answered by its deadline counts the CLI as installed: it was found and started', async (t) => {
  const deadlines: number[] = []
  const fakeRun = async (_bin: string, _args: string[], deadlineMs: number) => {
    deadlines.push(deadlineMs)
    return 'timeout' as const
  }
  const logged: string[] = []
  t.mock.method(console, 'warn', (line: string) => { logged.push(line) })
  assert.equal(await isClaudeCliAvailable(fakeRun), true)
  assert.deepEqual(deadlines, [VERSION_PROBE_DEADLINE_MS], 'the probe is given its deadline')
  assert.deepEqual(logged, [`[agents] \`claude --version\` did not answer within ${VERSION_PROBE_DEADLINE_MS} ms: it was ended, and claude counts as installed (it started)`])
})

// A routine reads the same unanswered probe the other way. Read as the picker reads it, a routine whose CLI's
// `--version` hangs would go on to swap in its pinned model and hold it until the run's own bound; its run is skipped
// instead (execute.test.ts has the run).
test("a routine's reading of a probe that has not answered by its deadline is unavailable; the picker's stays installed", async (t) => {
  const timesOut = async () => 'timeout' as const
  const logged: string[] = []
  t.mock.method(console, 'warn', (line: string) => { logged.push(line) })
  assert.equal(await isCliAvailable('opencode', timesOut, 1234, 'unavailable'), false, 'the routine skips it')
  assert.equal(await isCliAvailable('opencode', timesOut, 1234), true, "the picker's reading is unchanged")
  assert.deepEqual(logged, [
    '[routines] `opencode --version` did not answer within 1234 ms: it was ended, and the routine skips opencode',
    '[agents] `opencode --version` did not answer within 1234 ms: it was ended, and opencode counts as installed (it started)',
  ])
  // An answer is read the same way by both.
  assert.equal(await isCliAvailable('opencode', async () => true, 1234, 'unavailable'), true)
  assert.equal(await isCliAvailable('opencode', async () => false, 1234, 'unavailable'), false)
  assert.equal(logged.length, 2, 'only a timeout is logged')
})
