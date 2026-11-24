import { test } from 'node:test'
import assert from 'node:assert/strict'
import { agentSwitchPatch, buildAgentConfig, conversationAfterSwitch, hardwareSection, promptLooksCustomised, skillIdsAfterSwitch } from './agent-conversation'
import { resolveAgents } from './personas'

const NO_PERSONALIZATION = { assistantName: '', userName: '', customInstructions: '' }
const agents = resolveAgents(
  [{ id: 'writer', name: 'Writer', description: 'd', systemPrompt: 'You write.', skillIds: ['s-write'], tools: ['web_search'] }],
  {},
)
const byId = (id: string) => agents.find((a) => a.id === id)

test('buildAgentConfig: Blank is an empty prompt and an explicit empty tool list', () => {
  const cfg = buildAgentConfig('blank', byId('blank'), NO_PERSONALIZATION)
  assert.equal(cfg.systemPrompt, '')
  assert.deepEqual(cfg.allowedTools, [])
  assert.equal(cfg.toolPolicy, undefined)
})

test('buildAgentConfig: an untouched built-in leaves tools unrestricted and carries its system prompt', () => {
  const cfg = buildAgentConfig('concise', byId('concise'), NO_PERSONALIZATION)
  assert.equal(cfg.allowedTools, undefined)
  assert.ok(cfg.systemPrompt.includes(byId('concise')!.systemPrompt))
})

test('buildAgentConfig: Research forces web search, and no other agent does', () => {
  assert.equal(buildAgentConfig('research', byId('research'), NO_PERSONALIZATION).toolPolicy, 'force_web_search')
  assert.equal(buildAgentConfig('detailed', byId('detailed'), NO_PERSONALIZATION).toolPolicy, undefined)
})

test('buildAgentConfig: a custom agent brings its prompt, tool list and skills', () => {
  const cfg = buildAgentConfig('writer', byId('writer'), NO_PERSONALIZATION)
  assert.ok(cfg.systemPrompt.includes('You write.'))
  assert.deepEqual(cfg.allowedTools, ['web_search'])
  assert.deepEqual(cfg.agentSkillIds, ['s-write'])
})

test('buildAgentConfig: only the Expert agent gets the hardware section, with or without a base prompt', () => {
  const hw = hardwareSection({ gpus: [{ name: 'RTX 3050', vramMb: 6144 }], ramMB: 16384, os: 'win32' })
  assert.equal(hw, "## User's hardware\nGPU: RTX 3050 (6 GB VRAM)\nRAM: 16 GB\nOS: win32")
  assert.ok(buildAgentConfig('expert', byId('expert'), NO_PERSONALIZATION, { hardware: hw }).systemPrompt.endsWith(hw))
  assert.ok(!buildAgentConfig('concise', byId('concise'), NO_PERSONALIZATION, { hardware: hw }).systemPrompt.includes(hw))
  assert.equal(hardwareSection({ gpus: [], ramMB: 8192, os: 'linux' }).split('\n')[1], 'GPU: No GPU detected (CPU inference)')
})

test('skillIdsAfterSwitch: the old agent’s skills leave, the new agent’s join, the user’s own stay, no duplicates', () => {
  const previous = { ...byId('writer')!, skillIds: ['s-write', 's-shared'] }
  const next = buildAgentConfig('concise', { ...byId('concise')!, skillIds: ['s-shared', 's-new'] }, NO_PERSONALIZATION)
  assert.deepEqual(skillIdsAfterSwitch(['s-write', 's-shared', 'user-picked'], previous, next), ['user-picked', 's-shared', 's-new'])
  assert.deepEqual(skillIdsAfterSwitch(['user-picked'], undefined, buildAgentConfig('blank', byId('blank'), NO_PERSONALIZATION)), ['user-picked'])
})

test('agentSwitchPatch: clearing is sent as null so the server can tell it from "leave alone"', () => {
  const patch = agentSwitchPatch('concise', buildAgentConfig('concise', byId('concise'), NO_PERSONALIZATION), [])
  assert.equal(patch.chatAgentId, 'concise')
  assert.equal(patch.allowedTools, null)
  assert.equal(patch.toolPolicy, null)
  assert.deepEqual(patch.skillIds, [])
  const withTools = agentSwitchPatch('writer', buildAgentConfig('writer', byId('writer'), NO_PERSONALIZATION), ['s-write'])
  assert.deepEqual(withTools.allowedTools, ['web_search'])
  assert.deepEqual(agentSwitchPatch('blank', buildAgentConfig('blank', byId('blank'), NO_PERSONALIZATION), []).allowedTools, [])
})

test('promptLooksCustomised: what an agent generated is not customised, whatever the date, personalization or memory added after it', () => {
  const personalization = { assistantName: 'Ada', userName: 'Sam', customInstructions: 'Be brief.' }
  const generated = buildAgentConfig('concise', byId('concise'), personalization, { memoryFacts: ['likes tea'] }).systemPrompt
  assert.equal(promptLooksCustomised(generated, 'concise', byId('concise'), personalization), false)
  assert.equal(promptLooksCustomised(generated.replace(/Today's date is .*/, "Today's date is Monday, January 1, 2001"), 'concise', byId('concise'), personalization), false)
  const expert = buildAgentConfig('expert', byId('expert'), NO_PERSONALIZATION, { hardware: hardwareSection({ gpus: [], ramMB: 8192, os: 'linux' }) }).systemPrompt
  assert.equal(promptLooksCustomised(expert, 'expert', byId('expert')), false)
  assert.equal(promptLooksCustomised(buildAgentConfig('writer', byId('writer'), NO_PERSONALIZATION).systemPrompt, 'writer', byId('writer')), false)
})

test('promptLooksCustomised: Blank is empty, so any text is custom, and clearing another agent’s prompt is custom too', () => {
  assert.equal(promptLooksCustomised('', 'blank', byId('blank')), false)
  assert.equal(promptLooksCustomised('Answer in French.', 'blank', byId('blank')), true)
  assert.equal(promptLooksCustomised('', 'concise', byId('concise')), true)
})

test('promptLooksCustomised: a prompt written in Thread settings, or an agent edited since, is custom', () => {
  assert.equal(promptLooksCustomised('You are a pirate.', 'concise', byId('concise')), true)
  const edited = resolveAgents([], { concise: { systemPrompt: 'Edited later.' } }).find((a) => a.id === 'concise')
  const before = buildAgentConfig('concise', byId('concise'), NO_PERSONALIZATION).systemPrompt
  assert.equal(promptLooksCustomised(before, 'concise', edited), true)
})

// GitHub #52 review: a line appended to the generated prompt in Thread settings is the usual way people edit one. The old
// startsWith check let everything after the agent's prompt through, so the confirmation never showed for it.
test('promptLooksCustomised: a line appended after the generated prompt is custom, wherever it lands', () => {
  const personalization = { assistantName: 'Ada', userName: 'Sam', customInstructions: 'Be brief.' }
  const generated = buildAgentConfig('concise', byId('concise'), personalization, { memoryFacts: ['likes tea'] }).systemPrompt
  const custom = (text: string) => promptLooksCustomised(text, 'concise', byId('concise'), personalization)
  assert.equal(custom(`${generated}\n\nAnswer in French.`), true, 'a new block at the end')
  assert.equal(custom(`${generated}\nAnswer in French.`), true, 'a new line inside the memory block')
  const plain = buildAgentConfig('concise', byId('concise'), NO_PERSONALIZATION).systemPrompt
  assert.equal(promptLooksCustomised(`${plain}\n\nAnswer in French.`, 'concise', byId('concise')), true, 'on a chat with no personalization')
  assert.equal(promptLooksCustomised(`${plain}\n\n`, 'concise', byId('concise')), true, 'a bare trailing blank block is not generated either')
  const expert = buildAgentConfig('expert', byId('expert'), NO_PERSONALIZATION, { hardware: hardwareSection({ gpus: [], ramMB: 8192, os: 'linux' }) }).systemPrompt
  assert.equal(promptLooksCustomised(`${expert}\n\nAnswer in French.`, 'expert', byId('expert')), true, 'after the hardware block')
})

test('promptLooksCustomised: memory facts that changed since the chat began are not an edit, and neither is a renamed assistant', () => {
  const then = buildAgentConfig('concise', byId('concise'), { assistantName: 'Ada', userName: '', customInstructions: '' }, { memoryFacts: ['likes tea'] }).systemPrompt
  // the chat was made with one fact; the user has since gained others and renamed the assistant: matched by shape, so no dialog
  assert.equal(promptLooksCustomised(then, 'concise', byId('concise'), { assistantName: 'Bea', userName: 'Sam', customInstructions: '' }), false)
  const withMoreFacts = buildAgentConfig('concise', byId('concise'), NO_PERSONALIZATION, { memoryFacts: ['likes tea', 'lives in Leeds'] }).systemPrompt
  assert.equal(promptLooksCustomised(withMoreFacts, 'concise', byId('concise')), false)
})

test('promptLooksCustomised: custom instructions are compared by value, so changing them since the chat began shows the dialog once', () => {
  const then = buildAgentConfig('concise', byId('concise'), { assistantName: '', userName: '', customInstructions: 'Be brief.' }).systemPrompt
  assert.equal(promptLooksCustomised(then, 'concise', byId('concise'), { assistantName: '', userName: '', customInstructions: 'Be brief.' }), false)
  assert.equal(promptLooksCustomised(then, 'concise', byId('concise'), { assistantName: '', userName: '', customInstructions: 'Be verbose.' }), true)
})

test('conversationAfterSwitch: a field the switch cleared is cleared in the open chat, not kept from the old one', () => {
  const old = { id: 'c1', messages: [{ id: 'm1' }], chatAgentId: 'writer', systemPrompt: 'old', allowedTools: ['web_search'], toolPolicy: 'force_web_search', skillIds: ['s-write', 'user'] }
  // the PATCH answer: the stored chat without its messages; cleared fields are absent from the JSON
  const after = conversationAfterSwitch(old, { chatAgentId: 'concise', systemPrompt: 'new', skillIds: ['user'] })
  assert.equal(after.messages, old.messages, 'the messages are kept as they were')
  assert.deepEqual({ ...after }, { id: 'c1', messages: [{ id: 'm1' }], chatAgentId: 'concise', systemPrompt: 'new', allowedTools: undefined, toolPolicy: undefined, skillIds: ['user'] })
  const toBlank = conversationAfterSwitch(old, { chatAgentId: 'blank', systemPrompt: '', allowedTools: [], skillIds: [] })
  assert.deepEqual([toBlank.allowedTools, toBlank.toolPolicy], [[], undefined])
})

test('promptLooksCustomised: multiline custom instructions remain one generated block', () => {
  const personalization = { assistantName: 'Ada', userName: 'Sam', customInstructions: 'Be brief.\n\nUse examples.\n\nAvoid jargon.' }
  for (const id of ['concise', 'expert']) {
    const generated = buildAgentConfig(id, byId(id), personalization, {
      memoryFacts: ['likes tea'],
      hardware: hardwareSection({ gpus: [], ramMB: 8192, os: 'linux' }),
    }).systemPrompt
    assert.equal(promptLooksCustomised(generated, id, byId(id), personalization), false)
    assert.equal(promptLooksCustomised(`${generated}\n\nAnswer in French.`, id, byId(id), personalization), true)
    assert.equal(promptLooksCustomised(generated.replace('Use examples.', 'Use diagrams.'), id, byId(id), personalization), true)
  }
})

test('promptLooksCustomised: a custom-instruction prefix never hides appended edits', () => {
  const personalization = { assistantName: '', userName: '', customInstructions: 'Be brief.\n\nUse examples.' }
  const generated = buildAgentConfig('concise', byId('concise'), personalization).systemPrompt
  assert.equal(promptLooksCustomised(generated, 'concise', byId('concise'), personalization), false)
  assert.equal(promptLooksCustomised(`${generated} Answer in French.`, 'concise', byId('concise'), personalization), true)
  assert.equal(promptLooksCustomised(`${generated}\nAnswer in French.`, 'concise', byId('concise'), personalization), true)
})


test('promptLooksCustomised: CRLF and repeated blank lines in custom instructions remain generated', () => {
  for (const customInstructions of ['Be brief.\r\n\r\nUse examples.', 'Be brief.\n\n\nUse examples.', 'Your name is Ada.\n\nUse examples.']) {
    const personalization = { assistantName: '', userName: '', customInstructions }
    const generated = buildAgentConfig('concise', byId('concise'), personalization).systemPrompt
    assert.equal(promptLooksCustomised(generated, 'concise', byId('concise'), personalization), false)
    assert.equal(promptLooksCustomised(`${generated}\n\nAnswer in French.`, 'concise', byId('concise'), personalization), true)
  }
})
