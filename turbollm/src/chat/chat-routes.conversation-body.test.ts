// POST /api/v1/conversations and PATCH /api/v1/conversations/:id read a JSON body the caller wrote, and
// stored whatever it held: an object or array in a text field threw a SQLite bind error (Hono's default handler
// answered a bare 500 text/plain), a number in a text field was stored as "7.0", a `sampling` that was an array was
// stored and later spread into the engine request, and a `null` body crashed the route. The folder and message
// routes already answer 400 (see chat-routes.test.ts); these tests hold the conversation routes to the same rule.
import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { test } from 'node:test'
import { Hono } from 'hono'
import { registerChatRoutes } from './chat-routes.js'
import { ChatRuns } from './chat-runs.js'
import { ChatTurns } from './chat-turns.js'
import { ConversationStore } from './db.js'
import type { Deps } from '../deps.js'
import { tmpDir } from '../test-support/tmp'

function harness() {
  const dir = tmpDir('tllm-chat-conv-body-')
  const store = new ConversationStore(dir)
  const cfg = {
    modelDefaults: { maxTokens: 0 },
    gateway: { autoSwap: true },
    daemon: { autoGenerateTitles: false, experimental: { memory: false }, autoMemoryEnabled: false },
    tools: { toolPolicies: {}, autoAllowAll: false },
  }
  const d = {
    chatTurns: new ChatTurns(), chatRuns: new ChatRuns(),
    db: store,
    store: { snapshot: () => cfg, read: () => cfg, update: (fn: (c: never) => void) => fn(cfg as never), dir: () => dir },
    scanner: { list: () => ({ models: [], scanning: false, lastScanAt: '' }), get: () => undefined },
    registry: { active: () => ({ kind: 'llama.cpp', id: 'e1', capabilities: {} }) },
    modelRouter: { resolveRemoteTarget: () => undefined },
    manager: { status: () => ({ state: 'stopped' }), target: () => undefined, currentOpts: () => null },
  } as unknown as Deps
  const app = new Hono()
  registerChatRoutes(app, d)
  const send = (method: string, url: string, body: unknown) =>
    app.request(url, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  return { app, store, send, cleanup: () => { store.close(); rmSync(dir, { recursive: true, force: true }) } }
}

const BAD_TEXT = [7, { a: 1 }, ['x'], true]

test('POST /conversations refuses a text field that is not a string with 400 and stores nothing', async () => {
  const h = harness()
  try {
    for (const field of ['title', 'systemPrompt', 'modelKey', 'toolPolicy']) {
      for (const bad of BAD_TEXT) {
        const what = `${field}=${JSON.stringify(bad)}`
        const res = await h.send('POST', '/api/v1/conversations', { [field]: bad })
        assert.equal(res.status, 400, `${what}: ${await res.clone().text()}`)
        assert.deepEqual(await res.json(), { error: { code: 'invalid_input', message: `${field} must be a string.` } }, what)
      }
    }
    assert.equal(h.store.listConversationsPage('chat', { limit: 50 }).conversations.length, 0, 'no conversation was created')
  } finally {
    h.cleanup()
  }
})

test('PATCH /conversations/:id refuses a text field that is not a string with 400 and changes nothing', async () => {
  const h = harness()
  try {
    const conv = h.store.createConversation({ title: 'Keep', systemPrompt: 'Be kind.', modelKey: 'm1' })
    for (const field of ['title', 'systemPrompt', 'modelKey']) {
      for (const bad of BAD_TEXT) {
        const what = `${field}=${JSON.stringify(bad)}`
        const res = await h.send('PATCH', `/api/v1/conversations/${conv.id}`, { [field]: bad })
        assert.equal(res.status, 400, `${what}: ${await res.clone().text()}`)
        assert.deepEqual(await res.json(), { error: { code: 'invalid_input', message: `${field} must be a string.` } }, what)
      }
    }
    const after = h.store.getConversation(conv.id)!
    assert.deepEqual([after.title, after.systemPrompt, after.modelKey], ['Keep', 'Be kind.', 'm1'])
  } finally {
    h.cleanup()
  }
})

test('the conversation routes refuse a sampling that is not an object, a list that is not strings, and a non-boolean flag', async () => {
  const h = harness()
  try {
    const conv = h.store.createConversation({ sampling: { temp: 0.5 } })
    const cases: Array<[string, unknown, string]> = [
      ['sampling', 'hot', 'sampling must be an object.'],
      ['sampling', [1, 2], 'sampling must be an object.'],
      ['sampling', 7, 'sampling must be an object.'],
      ['skillIds', 'abc', 'skillIds must be an array of strings.'],
      ['skillIds', [1], 'skillIds must be an array of strings.'],
      ['allowedTools', 'web_search', 'allowedTools must be an array of strings.'],
      ['allowedTools', [{}], 'allowedTools must be an array of strings.'],
      ['preserveThinking', 'no', 'preserveThinking must be a boolean.'],
    ]
    for (const [field, bad, message] of cases) {
      // allowedTools is chosen when a chat is created; PATCH does not read it.
      const routes = [['POST', '/api/v1/conversations'], ['PATCH', `/api/v1/conversations/${conv.id}`]] as const
      for (const [method, url] of field === 'allowedTools' ? routes.slice(0, 1) : routes) {
        const what = `${method} ${field}=${JSON.stringify(bad)}`
        const res = await h.send(method, url, { [field]: bad })
        assert.equal(res.status, 400, `${what}: ${await res.clone().text()}`)
        assert.deepEqual(await res.json(), { error: { code: 'invalid_input', message } }, what)
      }
    }
    assert.deepEqual(h.store.getConversation(conv.id)!.sampling, { temp: 0.5 })
    assert.equal(h.store.listConversationsPage('chat', { limit: 50 }).conversations.length, 1, 'no extra conversation was created')
  } finally {
    h.cleanup()
  }
})

test('the conversation routes refuse a body that is not a JSON object with 400 (null crashed them)', async () => {
  const h = harness()
  try {
    const conv = h.store.createConversation()
    for (const bad of [null, [], 'str', 5]) {
      for (const [method, url] of [['POST', '/api/v1/conversations'], ['PATCH', `/api/v1/conversations/${conv.id}`]] as const) {
        const what = `${method} ${JSON.stringify(bad)}`
        const res = await h.send(method, url, bad)
        assert.equal(res.status, 400, `${what}: ${await res.clone().text()}`)
        assert.deepEqual(await res.json(), { error: { code: 'invalid_input', message: 'The body must be a JSON object.' } }, what)
      }
    }
  } finally {
    h.cleanup()
  }
})

test('the conversation routes still accept well-formed bodies, and an empty or unparsable body is still an empty object', async () => {
  const h = harness()
  try {
    const made = await h.send('POST', '/api/v1/conversations', {
      title: 'T', systemPrompt: 'S', modelKey: 'm', toolPolicy: 'force_web_search',
      skillIds: [], allowedTools: ['web_search'], sampling: { temp: 0.2 }, preserveThinking: false,
    })
    assert.equal(made.status, 201)
    const conv = (await made.json()) as { id: string; title: string; systemPrompt: string; modelKey: string; toolPolicy?: string; allowedTools?: string[]; sampling: object; preserveThinking: boolean }
    assert.deepEqual(
      [conv.title, conv.systemPrompt, conv.modelKey, conv.toolPolicy, conv.allowedTools, conv.sampling, conv.preserveThinking],
      ['T', 'S', 'm', 'force_web_search', ['web_search'], { temp: 0.2 }, false],
    )
    const patched = await h.send('PATCH', `/api/v1/conversations/${conv.id}`, { title: 'Renamed', sampling: { temp: 0.9 }, preserveThinking: true })
    assert.equal(patched.status, 200)
    const after = h.store.getConversation(conv.id)!
    assert.deepEqual([after.title, after.sampling, after.preserveThinking], ['Renamed', { temp: 0.9 }, true])
    // No body at all, and a body that is not JSON, are an empty object, as before.
    assert.equal((await h.app.request('/api/v1/conversations', { method: 'POST' })).status, 201)
    assert.equal((await h.app.request(`/api/v1/conversations/${conv.id}`, { method: 'PATCH', body: 'not json' })).status, 200)
    // An unknown conversation is still a 404.
    assert.equal((await h.send('PATCH', '/api/v1/conversations/nope', { title: 'x' })).status, 404)
  } finally {
    h.cleanup()
  }
})

test('the folder routes refuse a body that is not a JSON object, and the move route a folderId that is not a string', async () => {
  const h = harness()
  try {
    const folder = h.store.createFolder('Work')
    const conv = h.store.createConversation()
    for (const bad of [null, [], 'str', 5]) {
      for (const [method, url] of [['POST', '/api/v1/folders'], ['PATCH', `/api/v1/folders/${folder.id}`], ['PATCH', `/api/v1/conversations/${conv.id}/folder`]] as const) {
        const what = `${method} ${url.replace(folder.id, ':folder').replace(conv.id, ':conv')} ${JSON.stringify(bad)}`
        const res = await h.send(method, url, bad)
        assert.equal(res.status, 400, `${what}: ${await res.clone().text()}`)
        assert.deepEqual(await res.json(), { error: { code: 'invalid_input', message: 'The body must be a JSON object.' } }, what)
      }
    }
    for (const bad of [7, { a: 1 }, ['x'], true]) {
      const res = await h.send('PATCH', `/api/v1/conversations/${conv.id}/folder`, { folderId: bad })
      assert.equal(res.status, 400, `folderId=${JSON.stringify(bad)}: ${await res.clone().text()}`)
      assert.deepEqual(await res.json(), { error: { code: 'invalid_input', message: 'folderId must be a string.' } })
    }
    assert.equal(h.store.getConversation(conv.id)!.folderId, null, 'nothing moved')
    assert.deepEqual(h.store.listFolders().map((f) => f.name), ['Work'], 'nothing created or renamed')
    // A string moves the chat in, null moves it out again.
    assert.equal((await h.send('PATCH', `/api/v1/conversations/${conv.id}/folder`, { folderId: folder.id })).status, 200)
    assert.equal(h.store.getConversation(conv.id)!.folderId, folder.id)
    assert.equal((await h.send('PATCH', `/api/v1/conversations/${conv.id}/folder`, { folderId: null })).status, 200)
    assert.equal(h.store.getConversation(conv.id)!.folderId, null)
  } finally {
    h.cleanup()
  }
})

// A null in a field that cannot be cleared read as "absent" on create (`??` defaults) but reached the store on PATCH:
// `skillIds: null` threw (`null.filter`), a null title/systemPrompt/modelKey hit a NOT NULL constraint (500),
// `preserveThinking: null` silently wrote false and `sampling: null` stored the string "null".
test('PATCH /conversations/:id reads a null in a field that cannot be cleared as absent, and changes nothing', async () => {
  const h = harness()
  try {
    const conv = h.store.createConversation({ title: 'Keep', systemPrompt: 'Be kind.', modelKey: 'm1', sampling: { temp: 0.5 }, skillIds: ['s1'], preserveThinking: true })
    for (const field of ['title', 'systemPrompt', 'modelKey', 'sampling', 'skillIds', 'preserveThinking']) {
      const res = await h.send('PATCH', `/api/v1/conversations/${conv.id}`, { [field]: null })
      assert.equal(res.status, 200, `${field}=null: ${await res.clone().text()}`)
    }
    const res = await h.send('PATCH', `/api/v1/conversations/${conv.id}`, { title: null, systemPrompt: null, modelKey: null, sampling: null, skillIds: null, preserveThinking: null })
    assert.equal(res.status, 200)
    const after = h.store.getConversation(conv.id)!
    assert.deepEqual([after.title, after.systemPrompt, after.modelKey, after.sampling, after.skillIds, after.preserveThinking], ['Keep', 'Be kind.', 'm1', { temp: 0.5 }, ['s1'], true])
    // Unknown keys in the body are not applied to anything.
    assert.equal((await h.send('PATCH', `/api/v1/conversations/${conv.id}`, { title: 'Next', kind: 'code', folderId: 'x' })).status, 200)
    assert.deepEqual([h.store.getConversation(conv.id)!.title, h.store.getConversation(conv.id)!.kind], ['Next', 'chat'])
  } finally {
    h.cleanup()
  }
})

test('the conversation routes refuse a sampling setting that is not a number, flag, name or list of strings', async () => {
  const h = harness()
  try {
    const conv = h.store.createConversation({ sampling: { temp: 0.5 } })
    for (const bad of ['x', { a: 1 }, null, [1], Number.NaN]) {
      for (const [method, url] of [['POST', '/api/v1/conversations'], ['PATCH', `/api/v1/conversations/${conv.id}`]] as const) {
        const value = bad === null ? null : bad
        const res = await h.send(method, url, { sampling: { temp: value, ...(typeof bad === 'string' ? { temp: 0.7 } : {}), topK: bad } })
        if (typeof bad === 'string') { assert.equal(res.status, method === 'POST' ? 201 : 200, `a string setting is a setting: ${bad}`); continue }
        assert.equal(res.status, 400, `${method} sampling.topK=${JSON.stringify(bad)}: ${await res.clone().text()}`)
        assert.match(((await res.json()) as { error: { message: string } }).error.message, /^sampling\.(temp|topK) must be a number, boolean, string or array of strings\.$/)
      }
    }
    // The kinds the engine mapping reads (numbers, `stop`, flags) are fine.
    const ok = await h.send('PATCH', `/api/v1/conversations/${conv.id}`, { sampling: { temp: 0.2, topK: 40, stop: ['</s>'], mirostat: true } })
    assert.equal(ok.status, 200)
    assert.deepEqual(h.store.getConversation(conv.id)!.sampling, { temp: 0.2, topK: 40, stop: ['</s>'], mirostat: true })
  } finally {
    h.cleanup()
  }
})
