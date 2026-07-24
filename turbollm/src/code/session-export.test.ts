// Unit tests for session-export.ts's Markdown serializer + filename sanitizer — both pure
// functions, tested directly without a DB/route (per this codebase's real-process-over-mocks
// discipline, these two are genuinely pure so there's nothing to fake).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { AgentRun, Conversation, Message } from '../chat/db'
import {
  EXPORT_TRUNCATE_LIMIT,
  codeSessionExportFilename,
  serializeCodeSessionMarkdown,
} from './session-export'

function makeRun(overrides: Partial<AgentRun> = {}): AgentRun {
  return {
    id: 'run-1',
    convId: 'conv-1',
    title: 'Fix the login bug',
    status: 'done',
    allowedTools: [],
    createdAt: '2026-07-20T10:00:00.000Z',
    updatedAt: '2026-07-20T10:05:00.000Z',
    repoRoot: 'C:\\repo',
    repoBranch: 'main',
    ...overrides,
  }
}

function makeConv(overrides: Partial<Conversation> = {}): Conversation {
  return {
    id: 'conv-1',
    title: 'Fix the login bug',
    systemPrompt: '',
    modelKey: 'm|q4|1',
    sampling: {},
    expertMode: false,
    kind: 'code',
    preserveThinking: true,
    agentMode: 'auto',
    createdAt: '2026-07-20T10:00:00.000Z',
    updatedAt: '2026-07-20T10:05:00.000Z',
    messages: [],
    ...overrides,
  }
}

function makeMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: 'msg-1',
    convId: 'conv-1',
    seq: 1,
    role: 'user',
    content: '',
    reasoning: '',
    attachments: [],
    textAttachments: [],
    toolCalls: [],
    stats: {},
    createdAt: '2026-07-20T10:00:00.000Z',
    variantGroup: null,
    isActive: true,
    branchOf: null,
    edited: false,
    ...overrides,
  }
}

// ── serializeCodeSessionMarkdown ──────────────────────────────────────────────

test('serializeCodeSessionMarkdown: empty session still produces a valid header-only document', () => {
  const md = serializeCodeSessionMarkdown(makeRun(), makeConv({ messages: [] }), { exportedAt: '2026-07-24T00:00:00.000Z' })
  assert.match(md, /^# Fix the login bug/)
  assert.match(md, /\*\*Session ID:\*\* run-1/)
  assert.match(md, /\*\*Repo:\*\* C:\\repo \(branch: main\)/)
  assert.match(md, /\*\*Exported:\*\* 2026-07-24T00:00:00\.000Z/)
  assert.match(md, /no messages in this session yet/)
})

test('serializeCodeSessionMarkdown: falls back to a placeholder title when run.title is blank', () => {
  const md = serializeCodeSessionMarkdown(makeRun({ title: '   ' }), makeConv())
  assert.match(md, /^# Untitled Code session/)
})

test('serializeCodeSessionMarkdown: omits the Repo line entirely when repoRoot is unset', () => {
  const md = serializeCodeSessionMarkdown(makeRun({ repoRoot: undefined, repoBranch: undefined }), makeConv())
  assert.ok(!md.includes('**Repo:**'))
})

test('serializeCodeSessionMarkdown: renders a normal multi-message session in seq order with a separator', () => {
  const messages = [
    makeMessage({ id: 'u1', seq: 1, role: 'user', content: 'Add a health check endpoint.' }),
    makeMessage({
      id: 'a1', seq: 2, role: 'assistant', content: 'Done — added /healthz.',
      timeline: [{ type: 'text', text: 'Done — added /healthz.' }],
    }),
  ]
  const md = serializeCodeSessionMarkdown(makeRun(), makeConv({ messages }))
  const userIdx = md.indexOf('## You')
  const asstIdx = md.indexOf('## Assistant')
  assert.ok(userIdx !== -1 && asstIdx !== -1 && userIdx < asstIdx, 'user message renders before the assistant reply')
  assert.match(md, /Add a health check endpoint\./)
  assert.match(md, /Done — added \/healthz\./)
  assert.match(md, /\n---\n/, 'messages are separated by a horizontal rule')
})

test('serializeCodeSessionMarkdown: sorts messages by seq even if the array arrives out of order', () => {
  const messages = [
    makeMessage({ id: 'a1', seq: 2, role: 'assistant', content: 'second', timeline: [{ type: 'text', text: 'second' }] }),
    makeMessage({ id: 'u1', seq: 1, role: 'user', content: 'first' }),
  ]
  const md = serializeCodeSessionMarkdown(makeRun(), makeConv({ messages }))
  assert.ok(md.indexOf('first') < md.indexOf('second'))
})

test('serializeCodeSessionMarkdown: renders reasoning in a collapsible <details> block', () => {
  const messages = [
    makeMessage({
      id: 'a1', seq: 1, role: 'assistant', content: 'Fixed it.', reasoning: 'The bug was an off-by-one.',
      timeline: [{ type: 'text', text: 'Fixed it.' }],
    }),
  ]
  const md = serializeCodeSessionMarkdown(makeRun(), makeConv({ messages }))
  assert.match(md, /<details>\n<summary>Reasoning<\/summary>/)
  assert.match(md, /The bug was an off-by-one\./)
})

test('serializeCodeSessionMarkdown: interleaves text and tool-call blocks in true timeline order, not grouped', () => {
  const messages = [
    makeMessage({
      id: 'a1', seq: 1, role: 'assistant', content: 'Reading the file, then editing it.',
      toolCalls: [
        { id: 't1', name: 'read', args: { path: 'src/a.ts' }, result: 'file contents' },
        { id: 't2', name: 'edit', args: { path: 'src/a.ts' }, diff: '-old\n+new' },
      ],
      timeline: [
        { type: 'text', text: 'Reading the file' },
        { type: 'tool', id: 't1' },
        { type: 'text', text: 'now editing' },
        { type: 'tool', id: 't2' },
      ],
    }),
  ]
  const md = serializeCodeSessionMarkdown(makeRun(), makeConv({ messages }))
  const iRead = md.indexOf('Reading the file')
  const iT1 = md.indexOf('### Tool call: `read`')
  const iEdit = md.indexOf('now editing')
  const iT2 = md.indexOf('### Tool call: `edit`')
  assert.ok(iRead < iT1 && iT1 < iEdit && iEdit < iT2, 'blocks render in exact timeline order')
})

test('serializeCodeSessionMarkdown: a tool call with a diff renders a fenced diff block, not raw JSON', () => {
  const messages = [
    makeMessage({
      id: 'a1', seq: 1, role: 'assistant',
      toolCalls: [{ id: 't1', name: 'edit', args: { path: 'a.ts' }, diff: '-const x = 1\n+const x = 2' }],
      timeline: [{ type: 'tool', id: 't1' }],
    }),
  ]
  const md = serializeCodeSessionMarkdown(makeRun(), makeConv({ messages }))
  assert.match(md, /```diff\n-const x = 1\n\+const x = 2\n```/)
})

test('serializeCodeSessionMarkdown: a failed tool call renders the error, not the (absent) result', () => {
  const messages = [
    makeMessage({
      id: 'a1', seq: 1, role: 'assistant',
      toolCalls: [{ id: 't1', name: 'bash', args: { cmd: 'exit 1' }, error: 'command failed with exit code 1' }],
      timeline: [{ type: 'tool', id: 't1' }],
    }),
  ]
  const md = serializeCodeSessionMarkdown(makeRun(), makeConv({ messages }))
  assert.match(md, /\*\*Error:\*\*/)
  assert.match(md, /command failed with exit code 1/)
})

test('serializeCodeSessionMarkdown: falls back to content + toolCalls (no true interleave) when timeline is absent', () => {
  const messages = [
    makeMessage({
      id: 'a1', seq: 1, role: 'assistant', content: 'Legacy message, pre-timeline.',
      toolCalls: [{ id: 't1', name: 'read', args: {}, result: 'ok' }],
      // timeline intentionally omitted — simulates a pre-existing-field message.
    }),
  ]
  const md = serializeCodeSessionMarkdown(makeRun(), makeConv({ messages }))
  assert.match(md, /Legacy message, pre-timeline\./)
  assert.match(md, /### Tool call: `read`/)
})

test('serializeCodeSessionMarkdown: a huge tool result is truncated with an inline note, not included in full', () => {
  const huge = 'x'.repeat(EXPORT_TRUNCATE_LIMIT + 5000)
  const messages = [
    makeMessage({
      id: 'a1', seq: 1, role: 'assistant',
      toolCalls: [{ id: 't1', name: 'read', args: {}, result: huge }],
      timeline: [{ type: 'tool', id: 't1' }],
    }),
  ]
  const md = serializeCodeSessionMarkdown(makeRun(), makeConv({ messages }))
  assert.ok(md.length < huge.length + 2000, 'output is bounded, not the full 25k-char result')
  assert.match(md, /truncated — 5,000 more characters/)
})

test('serializeCodeSessionMarkdown: text attachments render as a chip-like attached-files line', () => {
  const messages = [makeMessage({ role: 'user', content: 'See these files.', textAttachments: ['src/a.ts', 'src/b.ts'] })]
  const md = serializeCodeSessionMarkdown(makeRun(), makeConv({ messages }))
  assert.match(md, /\*\*Attached:\*\* `src\/a\.ts`, `src\/b\.ts`/)
})

test('serializeCodeSessionMarkdown: a genuinely large session (thousands of messages/tool calls) serializes quickly, not hanging', () => {
  const messages: Message[] = []
  const MESSAGE_COUNT = 4000
  for (let i = 0; i < MESSAGE_COUNT; i++) {
    if (i % 2 === 0) {
      messages.push(makeMessage({ id: `u${i}`, seq: i, role: 'user', content: `Task step ${i}: do the next thing.` }))
    } else {
      messages.push(makeMessage({
        id: `a${i}`, seq: i, role: 'assistant', content: `Done with step ${i}.`,
        toolCalls: [{ id: `t${i}`, name: 'edit', args: { path: `src/file-${i}.ts` }, diff: `-old line ${i}\n+new line ${i}` }],
        timeline: [{ type: 'text', text: `Done with step ${i}.` }, { type: 'tool', id: `t${i}` }],
      }))
    }
  }
  const start = performance.now()
  const md = serializeCodeSessionMarkdown(makeRun(), makeConv({ messages }))
  const elapsedMs = performance.now() - start
  assert.ok(elapsedMs < 5000, `serializing ${MESSAGE_COUNT} messages took ${elapsedMs.toFixed(0)}ms, expected well under 5000ms`)
  assert.ok(md.includes(`Task step 0:`), 'the first message survived')
  assert.ok(md.includes(`Done with step ${MESSAGE_COUNT - 1}.`), 'the last message survived')
  const headingCount = (md.match(/^## (You|Assistant)$/gm) ?? []).length
  assert.equal(headingCount, MESSAGE_COUNT, 'every message rendered as its own heading, none dropped')
})

// ── codeSessionExportFilename ─────────────────────────────────────────────────

test('codeSessionExportFilename: a normal title becomes a dashed, dated .md filename', () => {
  const name = codeSessionExportFilename('Fix the login bug', '2026-07-20T10:00:00.000Z', 'md')
  assert.equal(name, 'Fix-the-login-bug-2026-07-20.md')
})

test('codeSessionExportFilename: empty title falls back to a safe default name', () => {
  assert.equal(codeSessionExportFilename('', '2026-07-20T10:00:00.000Z', 'md'), 'code-session-2026-07-20.md')
  assert.equal(codeSessionExportFilename('   ', '2026-07-20T10:00:00.000Z', 'md'), 'code-session-2026-07-20.md')
})

test('codeSessionExportFilename: strips path separators and other illegal filesystem characters', () => {
  const name = codeSessionExportFilename('fix: src/auth.ts <bug>?', '2026-07-20T10:00:00.000Z', 'md')
  assert.ok(!/[\\/:*?"<>|]/.test(name), `filename still contains an illegal character: ${name}`)
})

test('codeSessionExportFilename: a title that is ONLY illegal characters falls back to the default', () => {
  const name = codeSessionExportFilename(':/\\*?"<>|', '2026-07-20T10:00:00.000Z', 'md')
  assert.equal(name, 'code-session-2026-07-20.md')
})

test('codeSessionExportFilename: unicode-only title falls back to the default rather than producing an empty slug', () => {
  const name = codeSessionExportFilename('修复登录错误 🐛', '2026-07-20T10:00:00.000Z', 'md')
  assert.equal(name, 'code-session-2026-07-20.md')
})

test('codeSessionExportFilename: a very long title is capped to a reasonable length', () => {
  const name = codeSessionExportFilename('a'.repeat(500), '2026-07-20T10:00:00.000Z', 'md')
  const slug = name.replace(/-2026-07-20\.md$/, '')
  assert.ok(slug.length <= 80, `slug is ${slug.length} chars, expected <= 80`)
})

test('codeSessionExportFilename: uses only the date portion of createdAt, ignoring time-of-day', () => {
  const name = codeSessionExportFilename('Task', '2026-07-20T23:59:59.999Z', 'md')
  assert.equal(name, 'Task-2026-07-20.md')
})
