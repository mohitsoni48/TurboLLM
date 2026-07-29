// A terminal-agent relaunch passes the CLI's session flag based on the daemon's
// `agent_runs.terminal_launched_once`, which is set optimistically at launch time — so it can be
// wrong in BOTH directions, and both are hard failures the founder hit live:
//   --resume <id>     on an id the CLI never persisted -> "No conversation found with session ID: <id>"
//   --session-id <id> on an id the CLI already has     -> "Error: Session ID <id> is already in use."
// Neither flag is safe to pick blind, so launchCli swaps the flag and retries once on exactly
// those two self-identified failures — and on nothing else.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { EventEmitter } from 'node:events'
import { launchCli, swapSessionFlag } from './cli-launch.js'

const CLAUDE_FLAGS = {
  register: '--session-id',
  resume: '--resume',
  mismatch: ['no conversation found with session id', 'is already in use'],
}
const SESSION_ID = 'af4003a1-0cfb-461d-8c9e-4f2497c89214'

interface CapturedSpawn { cmd: string; args: string[] }

/** Fake spawn whose Nth child emits `stderr` then exits with `code`. */
function makeSpawn(script: Array<{ stderr?: string; code: number }>): {
  calls: CapturedSpawn[]
  fn: Parameters<typeof launchCli>[3]
} {
  const calls: CapturedSpawn[] = []
  const fn: Parameters<typeof launchCli>[3] = (cmd, args) => {
    const step = script[calls.length] ?? { code: 0 }
    calls.push({ cmd, args })
    const stderr = new EventEmitter()
    const child = new EventEmitter() as ReturnType<typeof import('node:child_process').spawn>
    ;(child as { stderr?: unknown }).stderr = stderr
    // Let launchCli attach its 'data'/'exit' listeners before anything fires.
    setImmediate(() => {
      if (step.stderr) stderr.emit('data', Buffer.from(step.stderr))
      setImmediate(() => child.emit('exit', step.code, null))
    })
    return child
  }
  return { calls, fn }
}

function stubFetch(): () => void {
  const original = globalThis.fetch
  globalThis.fetch = (async () => ({
    ok: true, status: 200,
    json: async () => ({ engine: { state: 'running' }, model: { name: 'ornith' } }),
  })) as unknown as typeof fetch
  return () => { globalThis.fetch = original }
}

/** launchCli writes a "▸ …" banner to stdout, and under the full `node --test` suite stdout IS
 *  the V8-serialized channel the parent runner parses — so raw writes corrupt it. Blanket-noop'ing
 *  stdout is equally wrong: node:test's reporter emits each test's result on a later tick, by
 *  which point the NEXT test has installed its stub, so results get eaten (symptom: only the last
 *  test in the file is ever reported). Swallow only our own banner lines and let everything else
 *  through. stderr is not the result channel, so it can be captured wholesale. */
function captureOutput(): { err: string[]; banners: string[]; restore: () => void } {
  const outW = process.stdout.write.bind(process.stdout)
  const errW = process.stderr.write.bind(process.stderr)
  const err: string[] = []
  const banners: string[] = []
  process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
    const s = String(chunk)
    if (s.startsWith('▸')) { banners.push(s); return true }
    return (outW as (...a: unknown[]) => boolean)(chunk, ...rest)
  }) as typeof process.stdout.write
  process.stderr.write = ((chunk: string | Uint8Array) => { err.push(String(chunk)); return true }) as typeof process.stderr.write
  return { err, banners, restore: () => { process.stdout.write = outW; process.stderr.write = errW } }
}

async function run(passthrough: string[], script: Array<{ stderr?: string; code: number }>) {
  const { calls, fn } = makeSpawn(script)
  const restoreFetch = stubFetch()
  const cap = captureOutput()
  let code: number
  try {
    code = await launchCli('claude', 6996, passthrough, fn)
  } finally {
    cap.restore()
    restoreFetch()
  }
  return { calls, code, stderr: cap.err.join(''), banners: cap.banners.join('') }
}

// ── swapSessionFlag ───────────────────────────────────────────────────────────

test('swapSessionFlag exchanges the flag and keeps the id argument in place', () => {
  assert.deepEqual(
    swapSessionFlag(['--resume', SESSION_ID], CLAUDE_FLAGS),
    ['--session-id', SESSION_ID],
  )
  assert.deepEqual(
    swapSessionFlag(['--session-id', SESSION_ID], CLAUDE_FLAGS),
    ['--resume', SESSION_ID],
  )
})

test('swapSessionFlag returns null when no session flag is present (hand-run `turbollm launch claude`)', () => {
  assert.equal(swapSessionFlag([], CLAUDE_FLAGS), null)
  assert.equal(swapSessionFlag(['--model', 'x'], CLAUDE_FLAGS), null)
})

// ── launchCli recovery ────────────────────────────────────────────────────────

test('a dead --resume id relaunches as a fresh session under the SAME id', async () => {
  const { calls, code, banners } = await run(
    ['--resume', SESSION_ID],
    [
      { stderr: `No conversation found with session ID: ${SESSION_ID}\n`, code: 1 },
      { code: 0 },
    ],
  )
  assert.equal(calls.length, 2, 'should retry exactly once')
  assert.deepEqual(calls[0].args, ['--resume', SESSION_ID])
  assert.deepEqual(calls[1].args, ['--session-id', SESSION_ID], 'retry registers the same id fresh')
  assert.equal(code, 0, 'the successful retry’s exit code wins')
  assert.match(banners, /starting a fresh one/)
})

test('an already-registered --session-id relaunches as a resume of that id', async () => {
  const { calls, code, banners } = await run(
    ['--session-id', SESSION_ID],
    [
      { stderr: `Error: Session ID ${SESSION_ID} is already in use.\n`, code: 1 },
      { code: 0 },
    ],
  )
  assert.equal(calls.length, 2)
  assert.deepEqual(calls[1].args, ['--resume', SESSION_ID])
  assert.equal(code, 0)
  // The banner must describe what actually happened — this direction RESUMES, it does not
  // start fresh, and saying otherwise would misreport the session the user is looking at.
  assert.match(banners, /already exists — resuming it/)
  assert.doesNotMatch(banners, /starting a fresh one/)
})

test('an unrelated non-zero exit is NOT retried — a real error must not run twice or be masked', async () => {
  const { calls, code } = await run(
    ['--resume', SESSION_ID],
    [{ stderr: 'Error: something else went wrong\n', code: 1 }],
  )
  assert.equal(calls.length, 1, 'no retry for a failure we did not cause')
  assert.equal(code, 1, 'the real exit code is passed through')
})

test('a clean exit is never retried', async () => {
  const { calls, code } = await run(['--resume', SESSION_ID], [{ code: 0 }])
  assert.equal(calls.length, 1)
  assert.equal(code, 0)
})

test('a launch with no session flag at all is spawned once, untouched', async () => {
  const { calls } = await run([], [{ stderr: 'No conversation found with session ID: x\n', code: 1 }])
  assert.equal(calls.length, 1, 'nothing to swap to, so nothing to retry')
})

test("the CLI's own stderr is forwarded verbatim, not swallowed by the recovery logic", async () => {
  const { stderr } = await run(
    ['--resume', SESSION_ID],
    [{ stderr: `No conversation found with session ID: ${SESSION_ID}\n`, code: 1 }, { code: 0 }],
  )
  assert.ok(
    stderr.includes(`No conversation found with session ID: ${SESSION_ID}`),
    'the user must still see what the CLI actually said',
  )
})
