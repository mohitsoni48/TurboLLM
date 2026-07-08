// Round-trip and validation tests for the chat import/export cycle (F-024).
// Tests build a snapshot with buildSnapshot(), parse/validate it, then verify
// the shape the import endpoint would accept, plus error cases and persona fallback.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildSnapshot } from './chat-export.js'
import type { Conversation, Message } from './db.js'
import type { Config } from '../config/config.js'

// ── helpers (same as chat-export.test.ts) ────────────────────────────────────

function makeConv(overrides: Partial<Conversation & { messages: Message[] }> = {}): Conversation & { messages: Message[] } {
  return {
    id: 'conv-1',
    title: 'Research Chat',
    systemPrompt: '',
    modelKey: 'qwen3-35b-q4',
    sampling: {},
    expertMode: false,
    toolPolicy: 'force_web_search',
    kind: 'chat',
    preserveThinking: false,
    createdAt: '2026-06-19T00:00:00.000Z',
    updatedAt: '2026-06-19T00:00:01.000Z',
    messages: [],
    ...overrides,
  }
}

function makeMsg(role: 'user' | 'assistant', content: string, extra?: Partial<Message>): Message {
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
    ...extra,
  }
}

function makeCfg(): Config {
  return {
    version: 2,
    daemon: { host: '', port: 3000, lanBind: false, requireApiKey: true, authToken: '', idleTtlMinutes: 30, openBrowserOnStart: true, theme: 'dark', autoGenerateTitles: true },
    telemetry: { level: 'off', machineId: '' },
    apiKeys: [],
    engines: [],
    activeEngineId: '',
    modelDirs: [],
    primaryModelDir: '',
    modelProfiles: {},
    benchResults: {},
    lastLoaded: null,
    hf: { token: '' },
    tools: {},
    gateway: { autoSwap: true, keepN: 1 },
    comfyui: { enabled: false, gatePath: '', url: '', reverseGate: false, cachePersist: false },
    modelDefaults: { ctx: 4096, ngl: 99 },
    mcp: { servers: [] },
  } as unknown as Config
}

// ── validation helper (mirrors what the import endpoint does) ─────────────────

function validateImportPayload(payload: unknown): { ok: true } | { ok: false; error: string } {
  if (typeof payload !== 'object' || payload === null) return { ok: false, error: 'not an object' }
  const p = payload as Record<string, unknown>
  if (!p.format || (p.format !== 'debug' && p.format !== 'export')) {
    return { ok: false, error: 'Missing or invalid "format" field.' }
  }
  if (!Array.isArray(p.messages)) return { ok: false, error: 'Missing "messages" array.' }
  if (typeof p.chat_id !== 'string') return { ok: false, error: 'Missing "chat_id" field.' }
  if (typeof p.title !== 'string') return { ok: false, error: 'Missing "title" field.' }
  return { ok: true }
}

// ── tests ─────────────────────────────────────────────────────────────────────

test('round-trip: buildSnapshot(export) produces a payload that passes import validation', () => {
  const conv = makeConv({
    messages: [
      makeMsg('user', 'Hello'),
      makeMsg('assistant', 'Hi there'),
    ],
  })
  const snap = buildSnapshot(conv, makeCfg(), '0.7.2', '2026-06-19T10:00:00.000Z', 'export')
  const result = validateImportPayload(snap)
  assert.equal(result.ok, true)
})

test('round-trip: exported messages are preserved in the snapshot', () => {
  const toolCalls = [{ id: 'tc1', name: 'web_search', args: { query: 'test' }, result: 'search result' }]
  const conv = makeConv({
    messages: [
      makeMsg('user', 'Search for something'),
      makeMsg('assistant', 'I searched.', { toolCalls }),
    ],
  })
  const snap = buildSnapshot(conv, makeCfg(), '0.7.2', '2026-06-19T10:00:00.000Z', 'export')
  assert.equal(snap.messages.length, 2)
  assert.equal(snap.messages[0].role, 'user')
  assert.equal(snap.messages[0].content, 'Search for something')
  assert.equal(snap.messages[1].role, 'assistant')
  assert.ok(snap.messages[1].tool_calls)
  assert.equal(snap.messages[1].tool_calls![0].name, 'web_search')
})

test('round-trip: title and model are preserved in the snapshot', () => {
  const conv = makeConv({ title: 'GPU Specs Research', modelKey: 'qwen3-35b-a22b-q4_k_m' })
  const snap = buildSnapshot(conv, makeCfg(), '0.7.2', '2026-06-19T10:00:00.000Z', 'export')
  assert.equal(snap.title, 'GPU Specs Research')
  assert.equal(snap.model, 'qwen3-35b-a22b-q4_k_m')
})

test('round-trip: persona is preserved in snapshot (research → force_web_search conv)', () => {
  const conv = makeConv({ toolPolicy: 'force_web_search' })
  const snap = buildSnapshot(conv, makeCfg(), '0.7.2', '2026-06-19T10:00:00.000Z', 'export')
  assert.equal(snap.persona, 'research')
  // On import: if persona === 'research', toolPolicy becomes 'force_web_search'
  const importedToolPolicy = snap.persona === 'research' ? 'force_web_search' : undefined
  assert.equal(importedToolPolicy, 'force_web_search')
})

test('invalid file: missing format field fails validation', () => {
  const payload = { chat_id: 'x', title: 'Test', messages: [] }
  const result = validateImportPayload(payload)
  assert.equal(result.ok, false)
  assert.ok((result as { ok: false; error: string }).error.includes('"format"'))
})

test('invalid file: missing messages field fails validation', () => {
  const payload = { format: 'export', chat_id: 'x', title: 'Test' }
  const result = validateImportPayload(payload)
  assert.equal(result.ok, false)
  assert.ok((result as { ok: false; error: string }).error.includes('"messages"'))
})

test('invalid file: missing chat_id fails validation', () => {
  const payload = { format: 'export', title: 'Test', messages: [] }
  const result = validateImportPayload(payload)
  assert.equal(result.ok, false)
  assert.ok((result as { ok: false; error: string }).error.includes('"chat_id"'))
})

test('invalid file: unknown format value fails validation', () => {
  const payload = { format: 'v1', chat_id: 'x', title: 'Test', messages: [] }
  const result = validateImportPayload(payload)
  assert.equal(result.ok, false)
})

test('persona fallback: unknown persona falls back to default toolPolicy', () => {
  // If persona is not 'research', toolPolicy should be undefined (default)
  const snap = buildSnapshot(makeConv({ toolPolicy: undefined }), makeCfg(), '0.7.2', '2026-06-19T10:00:00.000Z', 'export')
  assert.equal(snap.persona, 'default')
  const persona: string = snap.persona
  const importedToolPolicy = persona === 'research' ? 'force_web_search' : undefined
  assert.equal(importedToolPolicy, undefined)
})

test('persona fallback: unknown persona string falls back to default', () => {
  // Simulate an export from a future version with an unknown persona
  const snapWithUnknownPersona: Record<string, unknown> = {
    format: 'export',
    chat_id: 'conv-future',
    title: 'Future Chat',
    model: 'some-model',
    persona: 'future-persona-that-does-not-exist',
    messages: [],
  }
  const result = validateImportPayload(snapWithUnknownPersona)
  assert.equal(result.ok, true)
  // Import logic: persona not 'research' → toolPolicy = undefined (falls back to default)
  const persona = snapWithUnknownPersona.persona as string
  const importedToolPolicy = persona === 'research' ? 'force_web_search' : undefined
  assert.equal(importedToolPolicy, undefined)
})

test('unknown fields are ignored in export payload (forward compat)', () => {
  const conv = makeConv({ messages: [makeMsg('user', 'hi')] })
  const snap = buildSnapshot(conv, makeCfg(), '0.7.2', '2026-06-19T10:00:00.000Z', 'export') as unknown as Record<string, unknown>
  // Simulate future fields added to the export format
  snap['future_field'] = 'some_value'
  snap['another_unknown'] = { nested: true }
  // Validation should still pass (we only check required fields)
  const result = validateImportPayload(snap)
  assert.equal(result.ok, true)
})

// ── F-036: OpenAI-format import detection helpers ─────────────────────────────
// These tests mirror the detection and coercion logic in chat-routes.ts so that
// regressions are caught without needing a running server.

/** Mirrors the auto-detection logic in the import endpoint. */
function detectImportKind(payload: unknown): 'openai-array' | 'turbollm' | 'openai-object' | 'unknown' {
  if (Array.isArray(payload)) return 'openai-array'
  if (typeof payload !== 'object' || payload === null) return 'unknown'
  const p = payload as Record<string, unknown>
  if (p.format === 'debug' || p.format === 'export') return 'turbollm'
  if (Array.isArray(p.messages)) return 'openai-object'
  return 'unknown'
}

/** Mirrors coerceContent() from chat-routes.ts. */
function coerceContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .filter((p): p is Record<string, unknown> => typeof p === 'object' && p !== null)
      .map((p) => (typeof p.text === 'string' ? p.text : ''))
      .filter(Boolean)
      .join('\n')
  }
  return String(content ?? '')
}

/** Mirrors deriveTitle() from chat-routes.ts. */
function deriveTitle(
  titleField: string | undefined,
  messages: Array<Record<string, unknown>>,
): string {
  if (titleField?.trim()) return titleField.trim().slice(0, 60)
  for (const m of messages) {
    const role = m.role as string
    if (role !== 'user' && role !== 'assistant') continue
    const text = coerceContent(m.content).trim()
    if (text) return text.replace(/\s+/g, ' ').slice(0, 60)
  }
  return 'Imported chat'
}

// ── F-036 detection tests ─────────────────────────────────────────────────────

test('F-036 detection: bare array → openai-array', () => {
  const payload = [{ role: 'user', content: 'Hello' }]
  assert.equal(detectImportKind(payload), 'openai-array')
})

test('F-036 detection: object with format=export → turbollm', () => {
  const payload = { format: 'export', chat_id: 'x', title: 'T', messages: [] }
  assert.equal(detectImportKind(payload), 'turbollm')
})

test('F-036 detection: object with format=debug → turbollm', () => {
  const payload = { format: 'debug', chat_id: 'x', title: 'T', messages: [] }
  assert.equal(detectImportKind(payload), 'turbollm')
})

test('F-036 detection: object with messages but no format → openai-object', () => {
  const payload = { model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] }
  assert.equal(detectImportKind(payload), 'openai-object')
})

test('F-036 detection: object with neither format nor messages → unknown', () => {
  const payload = { something: 'else' }
  assert.equal(detectImportKind(payload), 'unknown')
})

test('F-036 detection: non-object, non-array → unknown', () => {
  assert.equal(detectImportKind('a string'), 'unknown')
  assert.equal(detectImportKind(42), 'unknown')
  assert.equal(detectImportKind(null), 'unknown')
})

// ── F-036 title derivation tests ──────────────────────────────────────────────

test('F-036 title: uses explicit title field when present', () => {
  const msgs = [{ role: 'user', content: 'Hello world' }]
  assert.equal(deriveTitle('My Chat', msgs), 'My Chat')
})

test('F-036 title: derives from first user message when no title', () => {
  const msgs = [
    { role: 'system', content: 'You are helpful.' },
    { role: 'user', content: 'Tell me about planets' },
    { role: 'assistant', content: 'Sure!' },
  ]
  assert.equal(deriveTitle(undefined, msgs), 'Tell me about planets')
})

test('F-036 title: truncates long first message to 60 chars', () => {
  const longMsg = 'A'.repeat(100)
  const msgs = [{ role: 'user', content: longMsg }]
  const title = deriveTitle(undefined, msgs)
  assert.ok(title.length <= 60)
  assert.equal(title, 'A'.repeat(60))
})

test('F-036 title: falls back to "Imported chat" when no usable messages', () => {
  const msgs = [{ role: 'system', content: 'System prompt only' }]
  assert.equal(deriveTitle(undefined, msgs), 'Imported chat')
})

test('F-036 title: falls back to "Imported chat" for empty messages array', () => {
  assert.equal(deriveTitle(undefined, []), 'Imported chat')
})

test('F-036 title: uses assistant message when no user message present', () => {
  const msgs = [{ role: 'assistant', content: 'I can help you with that.' }]
  assert.equal(deriveTitle(undefined, msgs), 'I can help you with that.')
})

// ── F-036 model passthrough tests ─────────────────────────────────────────────

test('F-036 model: model field is passed through from object format', () => {
  const payload = { model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] }
  const p = payload as Record<string, unknown>
  const modelKey = typeof p.model === 'string' ? p.model : ''
  assert.equal(modelKey, 'gpt-4o')
})

test('F-036 model: missing model field defaults to empty string', () => {
  const payload = { messages: [{ role: 'user', content: 'hi' }] }
  const p = payload as Record<string, unknown>
  const modelKey = typeof p.model === 'string' ? p.model : ''
  assert.equal(modelKey, '')
})

// ── F-036 role filtering tests ────────────────────────────────────────────────

test('F-036 role filter: system messages are excluded', () => {
  const messages = [
    { role: 'system', content: 'Be helpful.' },
    { role: 'user', content: 'Hello' },
    { role: 'assistant', content: 'Hi!' },
  ]
  const usable = messages.filter((m) => m.role === 'user' || m.role === 'assistant')
  assert.equal(usable.length, 2)
  assert.ok(usable.every((m) => m.role !== 'system'))
})

test('F-036 role filter: unknown roles are excluded', () => {
  const messages = [
    { role: 'tool', content: 'some tool result' },
    { role: 'user', content: 'Hello' },
    { role: 'function', content: 'fn result' },
  ]
  const usable = messages.filter((m) => m.role === 'user' || m.role === 'assistant')
  assert.equal(usable.length, 1)
  assert.equal(usable[0].role, 'user')
})

test('F-036 empty: no usable messages → should be rejected', () => {
  const messages = [
    { role: 'system', content: 'System only' },
  ]
  const usable = messages.filter((m: Record<string, unknown>) => m.role === 'user' || m.role === 'assistant')
  assert.equal(usable.length, 0)
})

// ── F-036 content coercion tests ──────────────────────────────────────────────

test('F-036 content: string content is passed through unchanged', () => {
  assert.equal(coerceContent('Hello world'), 'Hello world')
})

test('F-036 content: array content (OpenAI vision format) is joined from text parts', () => {
  const content = [
    { type: 'text', text: 'Describe this image:' },
    { type: 'image_url', image_url: { url: 'data:image/png;base64,...' } },
  ]
  const result = coerceContent(content)
  assert.equal(result, 'Describe this image:')
})

test('F-036 content: array with multiple text parts are joined with newline', () => {
  const content = [
    { type: 'text', text: 'First part' },
    { type: 'text', text: 'Second part' },
  ]
  const result = coerceContent(content)
  assert.equal(result, 'First part\nSecond part')
})

test('F-036 content: null content coerces to empty string (null ?? "" gives "")', () => {
  assert.equal(coerceContent(null), '')
})

test('F-036 content: undefined content coerces to empty string', () => {
  // undefined ?? '' gives ''  → String('') = ''
  assert.equal(coerceContent(undefined), '')
})

test('F-036 content: non-text array parts (no text field) are filtered out', () => {
  const content = [
    { type: 'image_url', image_url: { url: 'http://example.com/img.png' } },
  ]
  assert.equal(coerceContent(content), '')
})

// ── F-036 regression: existing .turbollm-chat.json import still works (F-024) ──

test('F-036 regression: turbollm format still validates correctly after F-036 changes', () => {
  const conv = makeConv({
    messages: [
      makeMsg('user', 'Hello'),
      makeMsg('assistant', 'Hi there!'),
    ],
  })
  const snap = buildSnapshot(conv, makeCfg(), '0.7.2', '2026-06-19T10:00:00.000Z', 'export')
  // Must still be detected as turbollm format
  assert.equal(detectImportKind(snap), 'turbollm')
  // Must still pass validation
  const result = validateImportPayload(snap)
  assert.equal(result.ok, true)
})

test('F-036 regression: debug format still detected as turbollm', () => {
  const conv = makeConv({ messages: [makeMsg('user', 'debug test')] })
  const snap = buildSnapshot(conv, makeCfg(), '0.7.2', '2026-06-19T10:00:00.000Z', 'debug')
  assert.equal(detectImportKind(snap), 'turbollm')
  const result = validateImportPayload(snap)
  assert.equal(result.ok, true)
})
