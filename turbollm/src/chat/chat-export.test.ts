// Unit tests for the buildSnapshot pure function (F-023).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildSnapshot } from './chat-export.js'
import type { Conversation, Message } from './db.js'
import type { Config } from '../config/config.js'

// ── minimal stubs ─────────────────────────────────────────────────────────────

function makeConv(overrides: Partial<Conversation & { messages: Message[] }> = {}): Conversation & { messages: Message[] } {
  return {
    id: 'conv-1',
    title: 'Test Chat',
    systemPrompt: '',
    modelKey: 'qwen3-35b-q4',
    sampling: {},
    expertMode: false,
    toolPolicy: undefined,
    kind: 'chat',
    preserveThinking: false,
    createdAt: '2026-06-19T00:00:00.000Z',
    updatedAt: '2026-06-19T00:00:01.000Z',
    messages: [],
    ...overrides,
  }
}

function makeMsg(role: 'user' | 'assistant', content: string, overrides: Partial<Message> = {}): Message {
  return {
    id: 'msg-' + Math.random().toString(36).slice(2),
    convId: 'conv-1',
    seq: 1,
    role,
    content,
    reasoning: '',
    attachments: [],
    textAttachments: [],
    toolCalls: [],
    stats: {},
    createdAt: '2026-06-19T00:00:02.000Z',
    variantGroup: null,
    isActive: true,
    branchOf: null,
    edited: false,
    ...overrides,
  }
}

function makeCfg(overrides: Partial<Config> = {}): Config {
  return {
    version: 2,
    daemon: { host: '', port: 3000, lanBind: false, requireApiKey: true, authToken: '', idleTtlMinutes: 30, openBrowserOnStart: true, theme: 'dark', autoGenerateTitles: true },
    telemetry: { level: 'off', machineId: '' },
    apiKeys: [{ id: 'k1', name: 'test', hash: 'hash', prefix: 'tllm_', createdAt: '', lastUsedAt: null }],
    engines: [],
    activeEngineId: '',
    modelDirs: [],
    primaryModelDir: '',
    modelProfiles: {},
    benchResults: {},
    lastLoaded: null,
    hf: { token: '' },
    tools: { tavily: { apiKey: 'TAVILY-SECRET' } },
    gateway: { autoSwap: true, keepN: 2 },
    comfyui: { enabled: false, gatePath: '', url: '', reverseGate: false, cachePersist: false },
    modelDefaults: { ctx: 4096, ngl: 99 },
    mcp: { servers: [] },
    ...overrides,
  } as unknown as Config
}

const EXPORTED_AT = '2026-06-19T10:00:00.000Z'
const VERSION = '0.7.2'

// ── tests ─────────────────────────────────────────────────────────────────────

test('buildSnapshot: basic schema shape is correct', () => {
  const snap = buildSnapshot(makeConv(), makeCfg(), VERSION, EXPORTED_AT, 'debug')
  assert.equal(snap.turbollm_version, VERSION)
  assert.equal(snap.exported_at, EXPORTED_AT)
  assert.equal(snap.format, 'debug')
  assert.equal(snap.chat_id, 'conv-1')
  assert.equal(snap.title, 'Test Chat')
  assert.equal(snap.model, 'qwen3-35b-q4')
  assert.equal(snap.persona, 'default')
  assert.deepEqual(snap.messages, [])
})

test('buildSnapshot: export format discriminator', () => {
  const snap = buildSnapshot(makeConv(), makeCfg(), VERSION, EXPORTED_AT, 'export')
  assert.equal(snap.format, 'export')
})

test('buildSnapshot: messages are mapped with role, content, ts', () => {
  const conv = makeConv({
    messages: [
      makeMsg('user', 'Hello', { createdAt: '2026-06-19T00:01:00.000Z' }),
      makeMsg('assistant', 'Hi there', { createdAt: '2026-06-19T00:01:05.000Z' }),
    ],
  })
  const snap = buildSnapshot(conv, makeCfg(), VERSION, EXPORTED_AT, 'debug')
  assert.equal(snap.messages.length, 2)
  assert.equal(snap.messages[0].role, 'user')
  assert.equal(snap.messages[0].content, 'Hello')
  assert.equal(snap.messages[0].ts, '2026-06-19T00:01:00.000Z')
  assert.equal(snap.messages[1].role, 'assistant')
  assert.equal(snap.messages[1].content, 'Hi there')
})

test('buildSnapshot: tool_calls included on assistant turns that used tools', () => {
  const toolCalls = [{ id: 'tc1', name: 'web_search', args: { query: 'test' }, result: 'result text' }]
  const conv = makeConv({
    messages: [
      makeMsg('assistant', 'Let me search', { toolCalls }),
    ],
  })
  const snap = buildSnapshot(conv, makeCfg(), VERSION, EXPORTED_AT, 'debug')
  assert.ok(snap.messages[0].tool_calls)
  assert.equal(snap.messages[0].tool_calls![0].name, 'web_search')
})

test('buildSnapshot: no tool_calls key on messages without tool calls', () => {
  const conv = makeConv({ messages: [makeMsg('user', 'hello')] })
  const snap = buildSnapshot(conv, makeCfg(), VERSION, EXPORTED_AT, 'debug')
  assert.equal(snap.messages[0].tool_calls, undefined)
})

test('buildSnapshot: persona is "research" when toolPolicy is force_web_search', () => {
  const conv = makeConv({ toolPolicy: 'force_web_search' })
  const snap = buildSnapshot(conv, makeCfg(), VERSION, EXPORTED_AT, 'debug')
  assert.equal(snap.persona, 'research')
})

test('buildSnapshot: persona is "default" when toolPolicy is absent', () => {
  const conv = makeConv({ toolPolicy: undefined })
  const snap = buildSnapshot(conv, makeCfg(), VERSION, EXPORTED_AT, 'debug')
  assert.equal(snap.persona, 'default')
})

test('buildSnapshot: settings_snapshot reflects config values', () => {
  const cfg = makeCfg({ gateway: { keepN: 3, autoSwap: false }, tools: { tavily: { apiKey: 'KEY' } } })
  const snap = buildSnapshot(makeConv(), cfg, VERSION, EXPORTED_AT, 'debug')
  assert.equal(snap.settings_snapshot.keepN, 3)
  assert.equal(snap.settings_snapshot.autoSwap, false)
  assert.equal(snap.settings_snapshot.tavilyConfigured, true)
})

test('buildSnapshot: no secret fields — API keys not in snapshot', () => {
  const cfg = makeCfg({ tools: { tavily: { apiKey: 'TAVILY-SECRET' } } })
  const snap = buildSnapshot(makeConv(), cfg, VERSION, EXPORTED_AT, 'debug')
  // Serialize to JSON and check the secret key value does not appear
  const json = JSON.stringify(snap)
  assert.ok(!json.includes('TAVILY-SECRET'), 'API key secret must not appear in snapshot')
})

test('buildSnapshot: tavilyConfigured is false when key absent', () => {
  const cfg = makeCfg({ tools: {} })
  const snap = buildSnapshot(makeConv(), cfg, VERSION, EXPORTED_AT, 'debug')
  assert.equal(snap.settings_snapshot.tavilyConfigured, false)
})

test('buildSnapshot: settings_snapshot keepN defaults to 1 when gateway absent', () => {
  const cfg = makeCfg({ gateway: undefined as unknown as Config['gateway'] })
  const snap = buildSnapshot(makeConv(), cfg, VERSION, EXPORTED_AT, 'debug')
  assert.equal(snap.settings_snapshot.keepN, 1)
  assert.equal(snap.settings_snapshot.autoSwap, true)
})
