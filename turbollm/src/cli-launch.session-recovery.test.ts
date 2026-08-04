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
import { launchCli, swapSessionFlag, type ConfigFs } from './cli-launch.js'

const CLAUDE_FLAGS = { register: '--session-id', resume: '--resume' }

// This file's tests are entirely about the session-flag-swap-and-retry behavior, not the
// (unrelated) MCP config launchCli also writes — a throwing fs keeps that write out of the
// picture entirely (no real disk I/O, and no --mcp-config appended to `args`, so every
// exact-equality assertion on the spawn args below stays exactly what it was written to check).
const NO_OP_FS: ConfigFs = {
  home: '/unused',
  readFile: async () => { throw new Error('not used by this test file') },
  writeFile: async () => { throw new Error('not used by this test file') },
  mkdir: async () => { throw new Error('not used by this test file') },
}
const SESSION_ID = 'af4003a1-0cfb-461d-8c9e-4f2497c89214'

interface CapturedSpawn { cmd: string; args: string[] }

/** Fake spawn whose Nth child exits with `code` (optionally via `signal`). */
function makeSpawn(script: Array<{ code: number; signal?: string }>): {
  calls: CapturedSpawn[]
  fn: Parameters<typeof launchCli>[3]
} {
  const calls: CapturedSpawn[] = []
  const fn: Parameters<typeof launchCli>[3] = (cmd, args) => {
    const step = script[calls.length] ?? { code: 0 }
    calls.push({ cmd, args })
    const child = new EventEmitter() as ReturnType<typeof import('node:child_process').spawn>
    // Let launchCli attach its 'exit' listener before anything fires.
    setImmediate(() => child.emit('exit', step.signal ? null : step.code, step.signal ?? null))
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

async function run(passthrough: string[], script: Array<{ code: number; signal?: string }>) {
  const { calls, fn } = makeSpawn(script)
  const restoreFetch = stubFetch()
  const cap = captureOutput()
  let code: number
  try {
    code = await launchCli('claude', 6996, passthrough, fn, undefined, undefined, undefined, NO_OP_FS)
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
    [{ code: 1 }, { code: 0 }],
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
    [{ code: 1 }, { code: 0 }],
  )
  assert.equal(calls.length, 2)
  assert.deepEqual(calls[1].args, ['--resume', SESSION_ID])
  assert.equal(code, 0)
  // The banner must describe what actually happened — this direction RESUMES, it does not
  // start fresh, and saying otherwise would misreport the session the user is looking at.
  assert.match(banners, /already exists — resuming it/)
  assert.doesNotMatch(banners, /starting a fresh one/)
})

test('the retry happens at most once — a second failure surfaces the real exit code', async () => {
  // The accepted cost of deciding on exit-code-and-speed instead of reading the CLI's stderr
  // (which cannot be intercepted inside a ConPTY without aborting the process): an unrelated
  // startup failure is attempted twice. It must still end with the genuine exit code, and must
  // never loop.
  const { calls, code } = await run(['--resume', SESSION_ID], [{ code: 1 }, { code: 1 }])
  assert.equal(calls.length, 2, 'exactly one retry, never a loop')
  assert.equal(code, 1, 'the real exit code is what the user ends up with')
})

test('a clean exit is never retried', async () => {
  const { calls, code } = await run(['--resume', SESSION_ID], [{ code: 0 }])
  assert.equal(calls.length, 1)
  assert.equal(code, 0)
})

test('a signal (Ctrl-C) is never retried — the user quit on purpose', async () => {
  const { calls } = await run(['--resume', SESSION_ID], [{ code: 0, signal: 'SIGINT' }])
  assert.equal(calls.length, 1, 'quitting must not relaunch the agent')
})

test('a launch with no session flag at all is spawned once, untouched', async () => {
  const { calls } = await run([], [{ code: 1 }])
  assert.equal(calls.length, 1, 'nothing to swap to, so nothing to retry')
})
