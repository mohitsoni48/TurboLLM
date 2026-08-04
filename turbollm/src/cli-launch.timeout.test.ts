// BUG-002: launchCli must pass ANTHROPIC_TIMEOUT and ANTHROPIC_MAX_RETRIES to the
// spawned Claude Code process so it waits long enough for local LLM latency
// (30–120 s per response) instead of timing out and retrying.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { EventEmitter } from 'node:events'
import { launchCli, type ConfigFs } from './cli-launch.js'

// ── Helpers ───────────────────────────────────────────────────────────────────

// This file is about env vars only — a throwing fs keeps launchCli's (unrelated) MCP config
// write out of the picture: no real disk I/O, and no --mcp-config appended to args.
const NO_OP_FS: ConfigFs = {
  home: '/unused',
  readFile: async () => { throw new Error('not used by this test file') },
  writeFile: async () => { throw new Error('not used by this test file') },
  mkdir: async () => { throw new Error('not used by this test file') },
}

interface CapturedSpawn {
  cmd: string
  args: string[]
  env: Record<string, string | undefined>
}

/** Returns a fake spawn function + a record of calls made. */
function makeSpawn(): { calls: CapturedSpawn[]; fn: Parameters<typeof launchCli>[3] } {
  const calls: CapturedSpawn[] = []
  const fn: Parameters<typeof launchCli>[3] = (cmd, args, opts) => {
    calls.push({ cmd, args, env: (opts?.env ?? {}) as Record<string, string | undefined> })
    const ee = new EventEmitter() as ReturnType<typeof import('node:child_process').spawn>
    setImmediate(() => ee.emit('exit', 0, null))
    return ee
  }
  return { calls, fn }
}

/** Stub globalThis.fetch so launchCli sees a live daemon with a loaded model. */
function stubFetch(model = 'qwen3-8b'): () => void {
  const original = globalThis.fetch
  globalThis.fetch = (async () => ({
    ok: true,
    status: 200,
    json: async () => ({ engine: { state: 'running' }, model: { name: model } }),
  })) as unknown as typeof fetch
  return () => { globalThis.fetch = original }
}

/** Silence launchCli's own banner output for the duration of a call. launchCli writes a
 *  "▸ Launching…" banner to stdout; under the full `node --test` suite each file runs in a
 *  subprocess whose stdout IS the V8-serialized result channel the parent runner parses, so raw
 *  writes corrupt that stream ("Unable to deserialize cloned data").
 *
 *  But no-oping stdout wholesale (the previous approach) breaks the channel the other way: the
 *  reporter emits each test's result on a later tick, by which point the next test has installed
 *  its no-op, so results are swallowed and only the file's last test is reported — this file has
 *  2 tests and the runner counted 1. Measured: an actual failure still surfaced under the old
 *  helper, so this was lost coverage rather than silent green. launchCli's
 *  stdout writes all begin with '▸' (cli-launch.ts), so swallow exactly those and forward the
 *  rest. stderr is not the result channel and can still be dropped wholesale. */
function silenceOutput(): () => void {
  const outW = process.stdout.write.bind(process.stdout)
  const errW = process.stderr.write.bind(process.stderr)
  process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
    if (String(chunk).startsWith('▸')) return true
    return (outW as (...a: unknown[]) => boolean)(chunk, ...rest)
  }) as typeof process.stdout.write
  process.stderr.write = (() => true) as typeof process.stderr.write
  return () => {
    process.stdout.write = outW
    process.stderr.write = errW
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test('launchCli passes ANTHROPIC_TIMEOUT=300000 to Claude Code spawn', async () => {
  const { calls, fn } = makeSpawn()
  const restore = stubFetch()
  const unsilence = silenceOutput()
  try {
    await launchCli('claude', 6996, [], fn, undefined, undefined, undefined, NO_OP_FS)
  } finally {
    unsilence()
    restore()
  }
  assert.equal(calls.length, 1, 'spawn should be called once')
  assert.equal(
    calls[0].env['ANTHROPIC_TIMEOUT'],
    '300000',
    `Expected ANTHROPIC_TIMEOUT=300000, got ${calls[0].env['ANTHROPIC_TIMEOUT']}`,
  )
})

test('launchCli passes ANTHROPIC_MAX_RETRIES=0 to Claude Code spawn', async () => {
  const { calls, fn } = makeSpawn()
  const restore = stubFetch()
  const unsilence = silenceOutput()
  try {
    await launchCli('claude', 6996, [], fn, undefined, undefined, undefined, NO_OP_FS)
  } finally {
    unsilence()
    restore()
  }
  assert.equal(calls.length, 1, 'spawn should be called once')
  assert.equal(
    calls[0].env['ANTHROPIC_MAX_RETRIES'],
    '0',
    `Expected ANTHROPIC_MAX_RETRIES=0, got ${calls[0].env['ANTHROPIC_MAX_RETRIES']}`,
  )
})
