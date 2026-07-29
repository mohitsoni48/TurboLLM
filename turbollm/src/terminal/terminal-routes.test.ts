// Regression coverage for terminal-agent auto-resume across a daemon restart.
//
// V1 of this used claude's `--continue` ("resume the most recent conversation in the CURRENT
// DIRECTORY"), which turned out to be a real, live-reported bug: two Code sessions pointed at
// the same repoRoot can't be told apart by directory alone, so whichever one relaunched later
// would silently inherit whatever conversation was most recently active in that folder —
// "randomly resuming old conversations". Fixed by keying resumption on TurboLLM's OWN Code
// session id: `--session-id <id>` registers that fixed id with the CLI on a genuinely
// first-ever launch, `--resume <id>` resumes that EXACT session on every later one.
// buildTerminalLaunchCommand is the pure decision extracted from the POST .../terminal handler
// so it's testable without a live PTY/daemon (mirrors code-session.ts's codeEventToFrame).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildTerminalLaunchCommand } from './terminal-routes'

test('buildTerminalLaunchCommand: a genuinely first-ever launch registers this session\'s own id', () => {
  const cmd = buildTerminalLaunchCommand('claude', 6996, 'tok-123', 'session-abc', false)
  assert.equal(cmd, 'turbollm launch claude --port 6996 --token tok-123 --session-id session-abc')
})

test('buildTerminalLaunchCommand: a relaunch resumes the SAME session id, not "most recent in this directory"', () => {
  const cmd = buildTerminalLaunchCommand('claude', 6996, 'tok-123', 'session-abc', true)
  assert.equal(cmd, 'turbollm launch claude --port 6996 --token tok-123 --resume session-abc')
})

test('buildTerminalLaunchCommand: two different sessions never collide, first or relaunch', () => {
  const first = buildTerminalLaunchCommand('claude', 6996, 'tok-1', 'session-A', false)
  const second = buildTerminalLaunchCommand('claude', 6996, 'tok-2', 'session-B', false)
  assert.notEqual(first, second)
  assert.ok(first.includes('--session-id session-A'))
  assert.ok(second.includes('--session-id session-B'))

  const relaunchA = buildTerminalLaunchCommand('claude', 6996, 'tok-3', 'session-A', true)
  const relaunchB = buildTerminalLaunchCommand('claude', 6996, 'tok-4', 'session-B', true)
  assert.ok(relaunchA.includes('--resume session-A'))
  assert.ok(relaunchB.includes('--resume session-B'))
})

test('buildTerminalLaunchCommand: an agent with no confirmed session-id flags still starts fresh every time', () => {
  // opencode/kilo/openclaw/hermes/pi have no CONFIRMED --session-id/--resume equivalent yet —
  // must not guess unverified syntax, so neither flag pair is ever added.
  const first = buildTerminalLaunchCommand('opencode', 6996, 'tok-123', 'session-abc', false)
  const relaunch = buildTerminalLaunchCommand('opencode', 6996, 'tok-123', 'session-abc', true)
  assert.equal(first, 'turbollm launch opencode --port 6996 --token tok-123')
  assert.equal(relaunch, 'turbollm launch opencode --port 6996 --token tok-123')
})
