// Coverage for mapping TurboLLM's Code mode onto claude's --permission-mode.
//
// The risk this guards is specific: passing a mode name the installed CLI doesn't accept is a hard
// startup failure (commander rejects the choice before anything paints), and cli-launch.ts can't
// read the child's stderr to tell that apart from any other failure — piping it aborts natively
// inside a ConPTY (ADR-293). So the resolver must never invent a name, and must degrade to the
// long-standing one when it doesn't know what the binary accepts.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  claudePermissionModeChoices,
  parsePermissionModeChoices,
  resetPermissionModeChoicesCache,
  resolveClaudePermissionMode,
} from './agent-modes'

// Verbatim from `claude --help` on Claude Code 2.1.220 (wrapped exactly as the CLI wraps it).
const HELP_2_1_220 = `
  --model <model>                       Model for the current session.
  --permission-mode <mode>              Permission mode to use for the session
                                        (choices: "acceptEdits", "auto",
                                        "bypassPermissions", "manual",
                                        "dontAsk", "plan")
  --session-id <uuid>                   Use a specific session ID for the
`

// The vocabulary older Claude Code advertised, before auto/manual/dontAsk existed.
const HELP_LEGACY = `
  --permission-mode <mode>              Permission mode to use for the session
                                        (choices: "acceptEdits",
                                        "bypassPermissions", "default", "plan")
`

test('parsePermissionModeChoices: reads the wrapped, quoted choice list out of real help text', () => {
  assert.deepEqual(
    parsePermissionModeChoices(HELP_2_1_220),
    ['acceptEdits', 'auto', 'bypassPermissions', 'manual', 'dontAsk', 'plan'],
  )
})

test('parsePermissionModeChoices: reads the older vocabulary too', () => {
  assert.deepEqual(
    parsePermissionModeChoices(HELP_LEGACY),
    ['acceptEdits', 'bypassPermissions', 'default', 'plan'],
  )
})

test('parsePermissionModeChoices: help that never mentions the option yields [] (unknown, not "supports nothing")', () => {
  assert.deepEqual(parsePermissionModeChoices('Usage: claude [options]\n  --model <model>  a model\n'), [])
  assert.deepEqual(parsePermissionModeChoices(''), [])
})

test('resolveClaudePermissionMode: on a modern CLI each mode maps to its closest real counterpart', () => {
  const choices = parsePermissionModeChoices(HELP_2_1_220)
  assert.equal(resolveClaudePermissionMode('auto', choices), 'auto')
  assert.equal(resolveClaudePermissionMode('plan', choices), 'plan')
  assert.equal(resolveClaudePermissionMode('ask', choices), 'manual')
})

test('resolveClaudePermissionMode: on an older CLI it falls back to names that CLI actually has', () => {
  const choices = parsePermissionModeChoices(HELP_LEGACY)
  assert.equal(resolveClaudePermissionMode('auto', choices), 'acceptEdits')
  assert.equal(resolveClaudePermissionMode('plan', choices), 'plan')
  assert.equal(resolveClaudePermissionMode('ask', choices), 'default')
})

test('resolveClaudePermissionMode: unknown choices (probe failed) use the long-standing name', () => {
  // [] means "couldn't determine", NOT "accepts nothing" — launching with the legacy name is the
  // safer bet than launching with a name only new CLIs know.
  assert.equal(resolveClaudePermissionMode('auto', []), 'acceptEdits')
  assert.equal(resolveClaudePermissionMode('plan', []), 'plan')
  assert.equal(resolveClaudePermissionMode('ask', []), 'default')
})

test('resolveClaudePermissionMode: never returns a value the CLI didn\'t advertise', () => {
  // A CLI that dropped every name we know about must produce null (→ no flag at all), not a guess.
  assert.equal(resolveClaudePermissionMode('auto', ['somethingElse']), null)
  assert.equal(resolveClaudePermissionMode('ask', ['somethingElse']), null)
})

test('resolveClaudePermissionMode: an unrecognised TurboLLM mode adds no flag', () => {
  assert.equal(resolveClaudePermissionMode('yolo', ['auto', 'plan', 'manual']), null)
  assert.equal(resolveClaudePermissionMode('', ['auto']), null)
})

test('resolveClaudePermissionMode: bypassPermissions is never selected, even when offered', () => {
  // Picking "Auto" in the UI must not silently disable every permission check — that's a security
  // decision the founder never made. Same for dontAsk.
  const choices = ['acceptEdits', 'auto', 'bypassPermissions', 'manual', 'dontAsk', 'plan']
  for (const mode of ['auto', 'plan', 'ask']) {
    const resolved = resolveClaudePermissionMode(mode, choices)
    assert.ok(resolved !== 'bypassPermissions' && resolved !== 'dontAsk', `${mode} → ${resolved}`)
  }
})

test('claudePermissionModeChoices: probes once and reuses the answer', async () => {
  resetPermissionModeChoicesCache()
  let calls = 0
  const runner = async () => { calls++; return HELP_2_1_220 }
  const a = await claudePermissionModeChoices(runner)
  const b = await claudePermissionModeChoices(runner)
  assert.deepEqual(a, b)
  assert.equal(calls, 1, 'a terminal open must not spawn `claude --help` every time')
  resetPermissionModeChoicesCache()
})

test('claudePermissionModeChoices: concurrent first opens share one probe', async () => {
  resetPermissionModeChoicesCache()
  let calls = 0
  const runner = async () => {
    calls++
    await new Promise((r) => setTimeout(r, 5))
    return HELP_2_1_220
  }
  await Promise.all([claudePermissionModeChoices(runner), claudePermissionModeChoices(runner)])
  assert.equal(calls, 1)
  resetPermissionModeChoicesCache()
})

test('claudePermissionModeChoices: a throwing probe degrades to [] instead of failing the launch', async () => {
  resetPermissionModeChoicesCache()
  const choices = await claudePermissionModeChoices(async () => { throw new Error('claude not on PATH') })
  assert.deepEqual(choices, [])
  // …and [] still produces a usable launch flag.
  assert.equal(resolveClaudePermissionMode('auto', choices), 'acceptEdits')
  resetPermissionModeChoicesCache()
})
