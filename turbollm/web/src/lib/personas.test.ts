import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveAgents, buildSystemPrompt } from './personas'

// GitHub #52: "the model still is being fed tool instructions even in the blank template
// (which should not include a thing for 'raw' model response)". Blank's whole point is zero
// injected instructions — that has to include the tool-calling preamble many chat templates
// render whenever ANY tools are offered, not just the system prompt text.

test('resolveAgents: Blank resolves to an explicit empty tool list, not unrestricted', () => {
  const agents = resolveAgents([], {})
  const blank = agents.find((a) => a.id === 'blank')
  assert.ok(blank)
  assert.deepEqual(blank!.tools, [])
})

test('resolveAgents: an untouched built-in (e.g. Concise) stays unrestricted (tools undefined)', () => {
  const agents = resolveAgents([], {})
  const concise = agents.find((a) => a.id === 'concise')
  assert.ok(concise)
  assert.equal(concise!.tools, undefined)
})

test('resolveAgents: a saved override wins over the built-in default, even for Blank', () => {
  const agents = resolveAgents([], { blank: { tools: ['read', 'grep'] } })
  const blank = agents.find((a) => a.id === 'blank')
  assert.deepEqual(blank!.tools, ['read', 'grep'])
})

test('resolveAgents: an override that explicitly restricts to zero tools stays zero (not undefined)', () => {
  const agents = resolveAgents([], { concise: { tools: [] } })
  const concise = agents.find((a) => a.id === 'concise')
  assert.deepEqual(concise!.tools, [])
})

test('buildSystemPrompt: blank agent still returns an empty system prompt (unchanged)', () => {
  assert.equal(buildSystemPrompt('blank', 'ignored', { assistantName: '', userName: '', customInstructions: '' }), '')
})
