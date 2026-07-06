// Developer screen "Connect a CLI" snippets. Regression: opencode/kilo/openclaw/hermes
// must lead with the `turbollm launch <cli>` one-command flow — not just the old
// manual config-file/env-var instructions — now that the launch command supports them.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildConnectSnippets } from './routes'

const BASE = 'http://127.0.0.1:6996'

test('claude-code leads with the one-command launch step', () => {
  const r = buildConnectSnippets('claude-code', BASE, 'key', 'Model')
  assert.equal(r.steps[0].snippet, 'turbollm launch claude')
})

test('opencode leads with the one-command launch step, config snippet still present', () => {
  const r = buildConnectSnippets('opencode', BASE, 'key', 'Model')
  assert.equal(r.steps[0].snippet, 'turbollm launch opencode')
  assert.ok(r.steps.some((s) => s.snippet.includes('opencode.json') || s.lang === 'json'))
})

test('kilo leads with the one-command launch step, config snippet still present', () => {
  const r = buildConnectSnippets('kilo', BASE, 'key', 'Model')
  assert.equal(r.steps[0].snippet, 'turbollm launch kilo')
  assert.ok(r.steps.some((s) => s.lang === 'jsonc'))
})

test('openclaw is a known CLI with a one-command launch step and a config fallback', () => {
  const r = buildConnectSnippets('openclaw', BASE, 'key', 'Model', 'model|q4|1')
  assert.equal(r.steps[0].snippet, 'turbollm launch openclaw')
  const config = r.steps.find((s) => s.lang === 'json')
  assert.ok(config, 'expected a JSON config fallback step')
  assert.ok(config!.snippet.includes('model|q4|1'), 'the fallback should key the provider by the model KEY, not the display name')
})

test('hermes is a known CLI with a one-command launch step and a config-set fallback', () => {
  const r = buildConnectSnippets('hermes', BASE, 'key', 'Model', 'model|q4|1')
  assert.equal(r.steps[0].snippet, 'turbollm launch hermes')
  // modelKey is quoted in the snippet — a real key has spaces and `|`, both shell-breaking unquoted.
  assert.ok(r.steps.some((s) => s.snippet.includes('hermes config set model.default "model|q4|1"')))
})

test('qwen (not a turbollm launch target) has no one-command step', () => {
  const r = buildConnectSnippets('qwen', BASE, 'key', 'Model')
  assert.ok(!r.steps.some((s) => s.snippet.startsWith('turbollm launch')))
})

test('unknown cli returns empty steps', () => {
  const r = buildConnectSnippets('nonexistent', BASE, 'key', 'Model')
  assert.deepEqual(r.steps, [])
})
