import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execListAgents, execCreateAgent, type AgentToolsStore } from './chat-agent-tools'
import type { CustomChatAgent } from '../config/config'

/** A minimal in-memory AgentToolsStore — the whole point of the interface being narrow
 *  (snapshot/update over customAgents only) is that tests never need a real ConfigStore. */
function fakeStore(initial: CustomChatAgent[] = []): AgentToolsStore {
  let customAgents = initial
  return {
    snapshot: () => ({ customAgents }),
    update: (fn) => {
      const cfg = { customAgents: [...customAgents] }
      fn(cfg)
      customAgents = cfg.customAgents
    },
  }
}

test('execListAgents: empty store says so instead of an empty list', () => {
  assert.equal(execListAgents({}, fakeStore()), 'No custom agents exist yet. Use create_agent to make one.')
})

test('execListAgents: lists id, name, description, and tools', () => {
  const store = fakeStore([
    { id: 'a1', name: 'Job Search', description: 'Finds jobs', systemPrompt: 'x', skillIds: [], tools: ['web_search', 'fetch_url'] },
  ])
  const out = execListAgents({}, store)
  assert.match(out, /a1/)
  assert.match(out, /Job Search/)
  assert.match(out, /Finds jobs/)
  assert.match(out, /web_search, fetch_url/)
})

test('execListAgents: an agent with no description/tools still renders a readable row', () => {
  const store = fakeStore([{ id: 'a1', name: 'Bare', description: '', systemPrompt: '', skillIds: [], tools: [] }])
  const out = execListAgents({}, store)
  assert.match(out, /\(no description\)/)
  assert.match(out, /\(none\)/)
})

test('execCreateAgent: missing name is rejected and nothing is created', () => {
  const store = fakeStore()
  const msg = execCreateAgent({}, store)
  assert.match(msg, /^Error:.*name/)
  assert.equal(store.snapshot().customAgents.length, 0)
})

test('execCreateAgent: whitespace-only name is rejected', () => {
  const store = fakeStore()
  const msg = execCreateAgent({ name: '   ' }, store)
  assert.match(msg, /^Error:/)
  assert.equal(store.snapshot().customAgents.length, 0)
})

test('execCreateAgent: creates an agent with a fresh id and echoes it back', () => {
  const store = fakeStore()
  const msg = execCreateAgent({ name: 'Job Search Assistant', description: 'Finds jobs', systemPrompt: 'Be factual.', tools: ['web_search', 'fetch_url'] }, store)
  assert.match(msg, /^Created agent [0-9a-f-]+ "Job Search Assistant"\.$/)
  const agents = store.snapshot().customAgents
  assert.equal(agents.length, 1)
  assert.equal(agents[0].name, 'Job Search Assistant')
  assert.equal(agents[0].description, 'Finds jobs')
  assert.equal(agents[0].systemPrompt, 'Be factual.')
  assert.deepEqual(agents[0].tools, ['web_search', 'fetch_url'])
  assert.deepEqual(agents[0].skillIds, [])
})

test('execCreateAgent: two calls never collide on id', () => {
  const store = fakeStore()
  execCreateAgent({ name: 'One' }, store)
  execCreateAgent({ name: 'Two' }, store)
  const [a, b] = store.snapshot().customAgents
  assert.notEqual(a.id, b.id)
})

test('execCreateAgent: non-string tools entries are dropped, not thrown', () => {
  const store = fakeStore()
  execCreateAgent({ name: 'Weird', tools: ['web_search', 42, null, 'fetch_url'] }, store)
  assert.deepEqual(store.snapshot().customAgents[0].tools, ['web_search', 'fetch_url'])
})

test('execCreateAgent: tools defaults to empty array when omitted or malformed', () => {
  const store = fakeStore()
  execCreateAgent({ name: 'NoTools' }, store)
  assert.deepEqual(store.snapshot().customAgents[0].tools, [])

  execCreateAgent({ name: 'BadTools', tools: 'not-an-array' }, store)
  assert.deepEqual(store.snapshot().customAgents[1].tools, [])
})

test('execCreateAgent: refuses once the cap is reached', () => {
  const fifty: CustomChatAgent[] = Array.from({ length: 50 }, (_, i) => (
    { id: `a${i}`, name: `Agent ${i}`, description: '', systemPrompt: '', skillIds: [], tools: [] }
  ))
  const store = fakeStore(fifty)
  const msg = execCreateAgent({ name: 'One too many' }, store)
  assert.match(msg, /^Error:.*limit/)
  assert.equal(store.snapshot().customAgents.length, 50)
})
