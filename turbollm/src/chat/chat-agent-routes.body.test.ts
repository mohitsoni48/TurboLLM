// The custom-agent, skill and onboarding routes read a JSON body the caller wrote. A text field that was a number,
// object or array threw (`.trim is not a function`: a bare 500 text/plain), `tools: "web_search"` silently left an agent
// with no tools, and a JSON `null` body crashed the routes whose first read was a field of it, because each route module
// kept its own copy of body() without the shared one's "not an object reads as {}" rule (api/http.ts). Each route now
// answers 400 for a bad field and treats a non-object body like an unparsable one.
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { test } from 'node:test'
import { Hono } from 'hono'
import { registerAgentRoutes } from '../agents/agent-routes.js'
import { registerOnboardingRoutes } from '../api/onboarding-routes.js'
import { ConfigStore } from '../config/config.js'
import type { Deps } from '../deps.js'
import { tmpDir } from '../test-support/tmp'
import { registerChatAgentRoutes } from './chat-agent-routes.js'

function harness() {
  const dir = tmpDir('tllm-agent-body-')
  const store = ConfigStore.load(join(dir, 'config.json'))
  const d = { store } as unknown as Deps
  const app = new Hono()
  registerChatAgentRoutes(app, d)
  registerAgentRoutes(app, d)
  registerOnboardingRoutes(app, { store })
  const send = (method: string, url: string, body: unknown) =>
    app.request(url, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  return { store, send, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

const BAD_TEXT = [7, { a: 1 }, ['x'], true]

test('the chat-agent routes refuse a text field that is not a string with 400 and change nothing', async () => {
  const h = harness()
  try {
    const made = await h.send('POST', '/api/v1/chat-agents', { name: 'Keep', description: 'd', systemPrompt: 's' })
    assert.equal(made.status, 201)
    const agent = (await made.json()) as { id: string }
    const before = JSON.stringify(h.store.snapshot().customAgents)
    const routes: Array<[string, string]> = [
      ['POST', '/api/v1/chat-agents'],
      ['PUT', `/api/v1/chat-agents/${agent.id}`],
      ['PUT', '/api/v1/chat-agents/builtin-overrides/blunt'],
    ]
    for (const [method, url] of routes) {
      for (const field of ['name', 'description', 'systemPrompt']) {
        for (const bad of BAD_TEXT) {
          const what = `${method} ${url.replace(agent.id, ':id')} ${field}=${JSON.stringify(bad)}`
          const res = await h.send(method, url, { name: 'x', [field]: bad })
          assert.equal(res.status, 400, `${what}: ${await res.clone().text()}`)
          assert.deepEqual(await res.json(), { error: { code: 'invalid_config_value', message: `${field} must be a string.` } }, what)
        }
      }
    }
    assert.equal(JSON.stringify(h.store.snapshot().customAgents), before, 'no agent changed or was added')
    assert.deepEqual(h.store.snapshot().builtinAgentOverrides, {}, 'no override was saved')
  } finally {
    h.cleanup()
  }
})

test('the chat-agent routes refuse skillIds or tools that are not arrays (a string used to mean "no tools")', async () => {
  const h = harness()
  try {
    const agent = (await (await h.send('POST', '/api/v1/chat-agents', { name: 'Keep', tools: ['web_search'] })).json()) as { id: string }
    for (const field of ['skillIds', 'tools']) {
      for (const bad of ['web_search', 7, { a: 1 }, true]) {
        for (const [method, url] of [['POST', '/api/v1/chat-agents'], ['PUT', `/api/v1/chat-agents/${agent.id}`], ['PUT', '/api/v1/chat-agents/builtin-overrides/blunt']]) {
          const what = `${method} ${field}=${JSON.stringify(bad)}`
          const res = await h.send(method, url, { name: 'x', [field]: bad })
          assert.equal(res.status, 400, `${what}: ${await res.clone().text()}`)
          assert.deepEqual(await res.json(), { error: { code: 'invalid_config_value', message: `${field} must be an array of strings.` } }, what)
        }
      }
    }
    assert.deepEqual(h.store.snapshot().customAgents.find((a) => a.id === agent.id)!.tools, ['web_search'], 'the tool list survived')
  } finally {
    h.cleanup()
  }
})

test('the chat-agent routes still take well-formed bodies, null fields and an empty body', async () => {
  const h = harness()
  try {
    const made = await h.send('POST', '/api/v1/chat-agents', { name: ' Writer ', description: null, systemPrompt: 'You write.', skillIds: ['a'], tools: [] })
    assert.equal(made.status, 201)
    const agent = (await made.json()) as { id: string; name: string; description: string; skillIds: string[]; tools: string[] }
    assert.deepEqual([agent.name, agent.description, agent.skillIds, agent.tools], ['Writer', '', ['a'], []])
    const edited = await h.send('PUT', `/api/v1/chat-agents/${agent.id}`, { name: 'Scribe', tools: ['web_search'] })
    assert.equal(edited.status, 200)
    assert.deepEqual(h.store.snapshot().customAgents[0].tools, ['web_search'])
    const override = await h.send('PUT', '/api/v1/chat-agents/builtin-overrides/blunt', { systemPrompt: 'Be blunt.', tools: [] })
    assert.equal(override.status, 200)
    assert.deepEqual(h.store.snapshot().builtinAgentOverrides.blunt, { systemPrompt: 'Be blunt.', tools: [] })
    assert.equal((await h.send('POST', '/api/v1/chat-agents', {})).status, 400, 'a name is still required')
  } finally {
    h.cleanup()
  }
})

test('a JSON body that is not an object (null crashed these routes) reads as an empty one', async () => {
  const h = harness()
  try {
    const agent = (await (await h.send('POST', '/api/v1/chat-agents', { name: 'Keep' })).json()) as { id: string }
    for (const bad of [null, [], 'str', 5]) {
      const post = await h.send('POST', '/api/v1/chat-agents', bad)
      assert.equal(post.status, 400, `POST ${JSON.stringify(bad)}: ${await post.clone().text()}`)
      assert.deepEqual(await post.json(), { error: { code: 'invalid_config_value', message: 'name is required.' } })
      assert.equal((await h.send('PUT', `/api/v1/chat-agents/${agent.id}`, bad)).status, 200, `PUT ${JSON.stringify(bad)}`)
      assert.equal((await h.send('PUT', '/api/v1/chat-agents/builtin-overrides/blunt', bad)).status, 200, `override ${JSON.stringify(bad)}`)
      const skill = await h.send('POST', '/api/v1/skills', bad)
      assert.equal(skill.status, 400, `skill ${JSON.stringify(bad)}: ${await skill.clone().text()}`)
      assert.equal((await h.send('POST', '/api/v1/skills/import', bad)).status, 400, `import ${JSON.stringify(bad)}`)
      assert.equal((await h.send('POST', '/api/v1/skills/learn-folder', bad)).status, 400, `learn-folder ${JSON.stringify(bad)}`)
      assert.equal((await h.send('PUT', '/api/v1/onboarding', bad)).status, 200, `onboarding ${JSON.stringify(bad)}`)
    }
  } finally {
    h.cleanup()
  }
})

test('the skill routes refuse a text field that is not a string with 400', async () => {
  const h = harness()
  try {
    const cases: Array<[string, string, Record<string, unknown>, string]> = [
      ['/api/v1/skills', 'id', { name: 'N', instructions: 'i' }, 'id'],
      ['/api/v1/skills', 'name', { id: 'ok-id', instructions: 'i' }, 'name'],
      ['/api/v1/skills', 'instructions', { id: 'ok-id', name: 'N' }, 'instructions'],
      ['/api/v1/skills', 'description', { id: 'ok-id', name: 'N', instructions: 'i' }, 'description'],
      ['/api/v1/skills/import', 'text', {}, 'text'],
      ['/api/v1/skills/learn-folder', 'folder', {}, 'folder'],
    ]
    for (const [url, field, base] of cases) {
      for (const bad of BAD_TEXT) {
        const what = `${url} ${field}=${JSON.stringify(bad)}`
        const res = await h.send('POST', url, { ...base, [field]: bad })
        assert.equal(res.status, 400, `${what}: ${await res.clone().text()}`)
        const { error } = (await res.json()) as { error: { message: string } }
        assert.equal(error.message, `${field} must be a string.`, what)
      }
    }
  } finally {
    h.cleanup()
  }
})

// Each route module kept its own body() that returned whatever JSON parsed, so a `null` crashed the first field read
// and the fix had to be repeated per module. api/http.ts holds the one rule; this keeps a module from growing another copy.
test('only the modules that deliberately differ declare their own body() reader', () => {
  const srcRoot = join(import.meta.dirname, '..')
  const own: string[] = []
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name)
      if (statSync(p).isDirectory()) { if (name !== 'node_modules') walk(p); continue }
      if (!p.endsWith('.ts') || p.endsWith('.test.ts')) continue
      if (/\basync function body</.test(readFileSync(p, 'utf8'))) own.push(relative(srcRoot, p).split(sep).join('/'))
    }
  }
  walk(srcRoot)
  // chat-routes.ts checks the shape itself (conversation-body.ts); the external API's has its own envelope and is
  // checked by its own tests. The shared one is api/http.ts.
  assert.deepEqual(own.sort(), ['api/http.ts', 'chat/chat-routes.ts', 'ext/routes.chats.ts'])
})

// The create route reads a null field as absent (`?.`, `??`); the edit routes called `.trim()` behind `!== undefined`, so the
// same null threw (500) on name/description and saved null as the system prompt.
test('the agent edit routes read a null field as absent: nothing changes, nothing throws', async () => {
  const h = harness()
  try {
    const agent = (await (await h.send('POST', '/api/v1/chat-agents', { name: 'Keep', description: 'd', systemPrompt: 's', tools: ['web_search'], skillIds: ['a'] })).json()) as { id: string }
    const before = JSON.stringify(h.store.snapshot().customAgents)
    for (const field of ['name', 'description', 'systemPrompt', 'tools', 'skillIds']) {
      const put = await h.send('PUT', `/api/v1/chat-agents/${agent.id}`, { [field]: null })
      assert.equal(put.status, 200, `PUT ${field}=null: ${await put.clone().text()}`)
      const override = await h.send('PUT', '/api/v1/chat-agents/builtin-overrides/blunt', { [field]: null })
      assert.equal(override.status, 200, `override ${field}=null: ${await override.clone().text()}`)
    }
    assert.equal(JSON.stringify(h.store.snapshot().customAgents), before)
    assert.deepEqual(h.store.snapshot().builtinAgentOverrides.blunt, {}, 'an override of nothing is empty, not full of nulls')
  } finally {
    h.cleanup()
  }
})

test('a tools or skillIds list with a non-string in it is refused, not read as "none"', async () => {
  const h = harness()
  try {
    const agent = (await (await h.send('POST', '/api/v1/chat-agents', { name: 'Keep', tools: ['web_search'] })).json()) as { id: string }
    for (const field of ['tools', 'skillIds']) {
      for (const bad of [[7], ['web_search', null], [['x']], [{}]]) {
        for (const [method, url] of [['POST', '/api/v1/chat-agents'], ['PUT', `/api/v1/chat-agents/${agent.id}`], ['PUT', '/api/v1/chat-agents/builtin-overrides/blunt']]) {
          const res = await h.send(method, url, { name: 'x', [field]: bad })
          assert.equal(res.status, 400, `${method} ${field}=${JSON.stringify(bad)}: ${await res.clone().text()}`)
          assert.equal(((await res.json()) as { error: { message: string } }).error.message, `${field} must be an array of strings.`)
        }
      }
    }
    assert.deepEqual(h.store.snapshot().customAgents.find((a) => a.id === agent.id)!.tools, ['web_search'])
  } finally {
    h.cleanup()
  }
})
