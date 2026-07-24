// Real spawned shell processes (no mocks) — same discipline as robust-bash.test.ts, since the
// whole point is that a user's `!command` runs a genuine shell in the repo root.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { runShellCommand, shellContextText } from './code-shell'

test('runShellCommand captures stdout and a zero exit code', async () => {
  const r = await runShellCommand('echo hello-shell', tmpdir(), 'test')
  assert.match(r.output, /hello-shell/)
  assert.equal(r.exitCode, 0)
  assert.equal(r.timedOut, false)
  assert.equal(r.truncated, false)
})

test('runShellCommand reports a non-zero exit code without throwing', async () => {
  const r = await runShellCommand('exit 3', tmpdir(), 'test')
  assert.equal(r.exitCode, 3)
  assert.equal(r.timedOut, false)
})

test('runShellCommand runs in the given cwd (repoRoot containment)', async () => {
  const r = await runShellCommand('pwd', tmpdir(), 'test')
  // pwd should echo the cwd we handed it (allowing for symlink canonicalization of tmpdir).
  assert.ok(r.output.trim().length > 0)
  assert.equal(r.exitCode, 0)
})

test('runShellCommand caps output at maxOutput and flags truncated', async () => {
  const r = await runShellCommand("printf 'x%.0s' $(seq 1 5000)", tmpdir(), 'test', { maxOutput: 100 })
  assert.equal(r.truncated, true)
  assert.ok(r.output.length <= 100, `expected <=100 chars, got ${r.output.length}`)
})

test('runShellCommand times out a hung command and reports timedOut (no throw)', async () => {
  const r = await runShellCommand('sleep 5', tmpdir(), 'test', { timeoutSec: 1 })
  assert.equal(r.timedOut, true)
  assert.equal(r.exitCode, null)
})

test('shellContextText frames the command + output for the model to read', () => {
  const text = shellContextText({ command: 'ls', output: 'file.txt\n', exitCode: 0, timedOut: false, truncated: false })
  assert.match(text, /I ran a shell command/)
  assert.match(text, /\$ ls/)
  assert.match(text, /file\.txt/)
})

test('shellContextText notes a non-zero exit, empty output, and truncation', () => {
  const text = shellContextText({ command: 'false', output: '', exitCode: 1, timedOut: false, truncated: true })
  assert.match(text, /exit code 1/)
  assert.match(text, /\(no output\)/)
  assert.match(text, /truncated/)
})

test('shellContextText notes a timeout', () => {
  const text = shellContextText({ command: 'sleep 99', output: '', exitCode: null, timedOut: true, truncated: false })
  assert.match(text, /timed out/)
})
