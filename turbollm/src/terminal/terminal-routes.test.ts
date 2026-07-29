// Regression coverage for terminal-agent auto-resume across a daemon restart: a restart kills
// the in-memory TerminalManager (and with it, the PTY), but the Code session itself survives in
// the DB. Before this, reopening a terminal after ANY restart always started a brand-new
// conversation with zero history — the founder-confirmed expected behavior is to auto-continue
// instead. buildTerminalLaunchCommand is the pure decision extracted from the POST .../terminal
// handler so it's testable without a live PTY/daemon (mirrors code-session.ts's
// codeEventToFrame pattern).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildTerminalLaunchCommand } from './terminal-routes'

test('buildTerminalLaunchCommand: a genuinely first-ever launch never adds a continue flag', () => {
  const cmd = buildTerminalLaunchCommand('claude', 6996, 'tok-123', false)
  assert.equal(cmd, 'turbollm launch claude --port 6996 --token tok-123')
})

test('buildTerminalLaunchCommand: a relaunch (restart-reconnect) adds claude\'s --continue flag', () => {
  const cmd = buildTerminalLaunchCommand('claude', 6996, 'tok-123', true)
  assert.equal(cmd, 'turbollm launch claude --port 6996 --token tok-123 --continue')
})

test('buildTerminalLaunchCommand: an agent with no confirmed continue flag still starts fresh on relaunch', () => {
  // opencode/kilo/openclaw/hermes/pi have no CONFIRMED continue syntax yet — must not guess one.
  const cmd = buildTerminalLaunchCommand('opencode', 6996, 'tok-123', true)
  assert.equal(cmd, 'turbollm launch opencode --port 6996 --token tok-123')
})
