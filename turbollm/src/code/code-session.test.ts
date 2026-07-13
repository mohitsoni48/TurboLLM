// Unit tests for the pure, isolable logic around a Code session:
//   • toolsForMode      — mode → pi tool set (persona.ts)
//   • toSessionStatus   — agent_runs.status → sidebar SessionStatus (code-routes.ts)
//   • MUTATING_TOOLS / PATH_TOOLS — the gating/containment contracts (code-session.ts)
//   • buildAppendPrompt — per-mode system-prompt assembly (persona.ts)
//
// The live agentic loop (pi SDK + a loaded model) is intentionally out of scope here — those
// paths are covered by the live SSE re-test, not by mocks.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { toolsForMode, buildAppendPrompt, skillsBlock, skillCatalogBlock, type CodeMode } from './persona'
import { toSessionStatus } from './code-routes'
import { MUTATING_TOOLS, PATH_TOOLS, resolveEffectiveHistory, compactCodeSession, isDependencyAddCommand } from './code-session'
import { ConversationStore } from '../chat/db'
import type { Deps } from '../deps'
import type { Skill } from '../agents/skills'

// ── toolsForMode ──────────────────────────────────────────────────────────────────

test('toolsForMode: plan is read-only (read/grep/find/ls, no mutating tools)', () => {
  const tools = toolsForMode('plan')
  assert.deepEqual(tools, ['read', 'grep', 'find', 'ls'])
  // The safety invariant: plan mode never exposes a mutating tool.
  for (const t of ['edit', 'write', 'bash']) assert.ok(!tools!.includes(t))
})

test('toolsForMode: auto and ask use pi defaults (undefined → caller omits `tools`)', () => {
  assert.equal(toolsForMode('auto'), undefined)
  assert.equal(toolsForMode('ask'), undefined)
})

// ── toSessionStatus (all six agent_runs.status values) ──────────────────────────────

test('toSessionStatus: done → done', () => {
  assert.equal(toSessionStatus('done'), 'done')
})

test('toSessionStatus: failed / cancelled / interrupted → aborted', () => {
  assert.equal(toSessionStatus('failed'), 'aborted')
  assert.equal(toSessionStatus('cancelled'), 'aborted')
  assert.equal(toSessionStatus('interrupted'), 'aborted')
})

test('toSessionStatus: running / queued → review', () => {
  assert.equal(toSessionStatus('running'), 'review')
  assert.equal(toSessionStatus('queued'), 'review')
})

// ── tool-set contracts ──────────────────────────────────────────────────────────────

test('MUTATING_TOOLS: exactly edit/write/bash are approval-gated in ask mode', () => {
  assert.deepEqual([...MUTATING_TOOLS].sort(), ['bash', 'edit', 'write'])
  // read-only tools must NOT be gated.
  for (const t of ['read', 'grep', 'find', 'ls']) assert.ok(!MUTATING_TOOLS.has(t))
})

test('PATH_TOOLS: path-checked tools include the fs tools but NOT bash', () => {
  assert.deepEqual([...PATH_TOOLS].sort(), ['edit', 'find', 'grep', 'ls', 'read', 'write'])
  // bash takes `command`, not `path` — it must not be containment-checked by path.
  assert.ok(!PATH_TOOLS.has('bash'))
})

test('isDependencyAddCommand: detects install/add commands across common package managers', () => {
  const positives = [
    'npm install left-pad',
    'npm i axios --save',
    'npm add lodash',
    'yarn add react',
    'pnpm add vite',
    'pip install requests',
    'pip3 install numpy',
    'poetry add django',
    'cargo add serde',
    'go get github.com/gorilla/mux',
    'gem install rails',
    'bundle add sinatra',
    'composer require monolog/monolog',
    'cd app && npm install express',
  ]
  for (const cmd of positives) assert.ok(isDependencyAddCommand(cmd), `expected match: ${cmd}`)
})

test('isDependencyAddCommand: does not flag bare/lockfile/local installs', () => {
  const negatives = [
    'npm install',
    'npm ci',
    'pip install -r requirements.txt',
    'pip install -e .',
    'npm run build',
    'npm test',
    'git commit -m "add dependency notes"',
  ]
  for (const cmd of negatives) assert.ok(!isDependencyAddCommand(cmd), `expected no match: ${cmd}`)
})

// ── buildAppendPrompt ───────────────────────────────────────────────────────────────

test('buildAppendPrompt: plan omits edit guidance; auto/ask include it', () => {
  const plan = buildAppendPrompt('plan')
  const auto = buildAppendPrompt('auto')
  const ask = buildAppendPrompt('ask')
  // Plan mode has no edit tool, so the edit-reliability and LSP blocks are both dropped.
  assert.equal(plan.length, 2)
  assert.equal(auto.length, 4)
  assert.equal(ask.length, 4)
  assert.ok(plan.every((b) => typeof b === 'string' && b.length > 0))
  // Every mode's guidance mentions its own name.
  assert.match(plan[1], /PLAN/)
  assert.match(auto[1], /AUTO/)
  assert.match(ask[1], /ASK/)
})

test('buildAppendPrompt: covers every CodeMode without throwing', () => {
  for (const m of ['auto', 'plan', 'ask'] as CodeMode[]) {
    assert.ok(Array.isArray(buildAppendPrompt(m)))
  }
})

// ── skills injection (Task 4 — Code sessions get the whole shared SkillStore) ───────

test('skillsBlock: empty skill list is a byte-identical no-op', () => {
  assert.equal(skillsBlock([]), '')
})

test('skillsBlock: formats every skill with the same header/cap chat uses', () => {
  const skills: Skill[] = [
    { id: 'a', name: 'Alpha', description: 'Does alpha things.', instructions: 'Do the alpha thing.', tools: [] },
    { id: 'b', name: 'Beta', description: 'Does beta things.', instructions: 'Do the beta thing.', tools: [] },
  ]
  const block = skillsBlock(skills)
  assert.match(block, /^Skills enabled for this chat \(apply the relevant ones\):/)
  assert.match(block, /## Alpha\nDoes alpha things\.\n\nDo the alpha thing\./)
  assert.match(block, /## Beta\nDoes beta things\.\n\nDo the beta thing\./)
})

test('skillsBlock: caps a pathological instructions body at 20,000 chars', () => {
  const huge: Skill = { id: 'x', name: 'Huge', description: 'd', instructions: 'x'.repeat(30_000), tools: [] }
  const block = skillsBlock([huge])
  // header + "## Huge\nd\n\n" + capped instructions
  const instructionsPart = block.split('\n\n').pop()!
  assert.equal(instructionsPart.length, 20_000)
})

test('buildAppendPrompt: with no skills argument, output is unchanged from before Task 4', () => {
  // basePersona + modeGuidance always; +editReliabilityGuidance +lspGuidance outside plan mode
  // (plan has no edit tool, see buildAppendPrompt's own comment); hasWebTools defaults false so
  // the item 1/2 blocks are omitted here (covered separately in persona.test.ts).
  for (const m of ['auto', 'plan', 'ask'] as CodeMode[]) {
    assert.equal(buildAppendPrompt(m).length, m === 'plan' ? 2 : 4)
  }
})

test('buildAppendPrompt: a skill catalog (not full instructions) is appended as a final block in every mode, including plan', () => {
  const skills: Skill[] = [{ id: 's', name: 'S', description: 'd', instructions: 'i', tools: [] }]
  for (const m of ['auto', 'plan', 'ask'] as CodeMode[]) {
    const withSkills = buildAppendPrompt(m, skills)
    const withoutSkills = buildAppendPrompt(m)
    assert.equal(withSkills.length, withoutSkills.length + 1)
    assert.equal(withSkills.at(-1), skillCatalogBlock(skills))
  }
})

// ── skill catalog (name+description only, budget-capped) ────────────────────────────

test('skillCatalogBlock: empty skill list is a no-op', () => {
  assert.equal(skillCatalogBlock([]), '')
})

test('skillCatalogBlock: one line per skill, id + description only — no instructions', () => {
  const skills: Skill[] = [
    { id: 'alpha', name: 'Alpha', description: 'Does alpha things.', instructions: 'SECRET INSTRUCTIONS', tools: [] },
    { id: 'beta', name: 'Beta', description: 'Does beta things.', instructions: 'SECRET INSTRUCTIONS', tools: [] },
  ]
  const block = skillCatalogBlock(skills)
  assert.match(block, /invoke_skill/)
  assert.match(block, /- \*\*alpha\*\* — Does alpha things\./)
  assert.match(block, /- \*\*beta\*\* — Does beta things\./)
  assert.doesNotMatch(block, /SECRET INSTRUCTIONS/)
})

test('skillCatalogBlock: enforces a total budget, dropping entries with a count rather than truncating silently', () => {
  // 500 entries x ~220 chars each (~110K total) is well past any reasonable budget — this must
  // overflow regardless of the exact constant, unlike a fixed small count that can silently stop
  // testing anything the moment the budget is raised (exactly what happened here once already:
  // raising it from 4,000 to 16,000 chars made a 50-entry/~11K-char fixture fit entirely).
  const skills: Skill[] = Array.from({ length: 500 }, (_, i) => ({
    id: `skill-${i}`, name: `Skill ${i}`, description: 'x'.repeat(200), instructions: '', tools: [],
  }))
  const unboundedChars = skills.reduce((n, s) => n + s.id.length + s.description.length, 0)
  const block = skillCatalogBlock(skills)
  assert.match(block, /…and \d+ more skill\(s\) not shown \(catalog budget reached\)\./)
  assert.ok(block.length < unboundedChars, 'catalog should be far smaller than the unbounded input')
})

test('buildAppendPrompt: an empty skills array behaves exactly like omitting the argument', () => {
  for (const m of ['auto', 'plan', 'ask'] as CodeMode[]) {
    assert.deepEqual(buildAppendPrompt(m, []), buildAppendPrompt(m))
  }
})

// ── resolveEffectiveHistory (manual /compact's replay-cut logic) ────────────────────
//
// The live agentic loop that PRODUCES a compaction (session.compact() against a real model)
// is intentionally out of scope here, same as the rest of this file — but the cut-point
// resolution it depends on (code-session.ts's compactCodeSession reads this same function) is
// pure DB logic and fully testable without one.

function makeCodeConv(): { d: Deps; store: ConversationStore; convId: string; sessionId: string } {
  const store = new ConversationStore(mkdtempSync(join(tmpdir(), 'tllm-compact-')))
  const conv = store.createConversation({ kind: 'code' })
  const run = store.createAgentRun({ convId: conv.id, title: 'test', allowedTools: [], repoRoot: '/repo' })
  const d = { db: store } as unknown as Deps
  return { d, store, convId: conv.id, sessionId: run.id }
}

test('resolveEffectiveHistory: no compaction yet — returns every message, no summary', () => {
  const { d, store, convId, sessionId } = makeCodeConv()
  store.addMessage(convId, 'user', 'first task')
  store.addMessage(convId, 'assistant', 'first reply')
  store.addMessage(convId, 'user', 'second task')

  const { summaryText, messages } = resolveEffectiveHistory(d, convId, sessionId)
  assert.equal(summaryText, null)
  assert.equal(messages.length, 3)
  assert.equal(messages[0].content, 'first task')
})

test('resolveEffectiveHistory: after a compaction marker — a wrapped summary plus only the messages after the cut', () => {
  const { d, store, convId, sessionId } = makeCodeConv()
  store.addMessage(convId, 'user', 'old task 1')
  const oldReply = store.addMessage(convId, 'assistant', 'old reply 1')
  store.addMessage(convId, 'user', 'new task 2')
  store.addMessage(convId, 'assistant', 'new reply 2')

  store.updateAgentRun(sessionId, {
    compactionSummary: 'Everything up to old reply 1, condensed.',
    compactionUpToMessageId: oldReply.id,
    compactionTokensBefore: 12345,
  })

  const { summaryText, messages } = resolveEffectiveHistory(d, convId, sessionId)
  assert.match(summaryText!, /^Summary of earlier conversation/)
  assert.match(summaryText!, /Everything up to old reply 1, condensed\./)
  assert.match(summaryText!, /the actual conversation continues below/)
  // Only the two messages AFTER the cut point — the summarized pair is gone from the raw list.
  assert.equal(messages.length, 2)
  assert.equal(messages[0].content, 'new task 2')
  assert.equal(messages[1].content, 'new reply 2')
})

test('resolveEffectiveHistory: a compaction marker pointing at a deleted/missing message id degrades to replaying everything raw', () => {
  const { d, store, convId, sessionId } = makeCodeConv()
  store.addMessage(convId, 'user', 'task')
  store.addMessage(convId, 'assistant', 'reply')
  store.updateAgentRun(sessionId, { compactionSummary: 'stale summary', compactionUpToMessageId: 'does-not-exist' })

  const { summaryText, messages } = resolveEffectiveHistory(d, convId, sessionId)
  // findIndex returns -1 for a missing id, so the cut can't be located — falling back to
  // replaying the raw messages is the safe choice (losing nothing) over silently dropping
  // everything because a stale/corrupt marker couldn't be resolved.
  assert.match(summaryText!, /stale summary/)
  assert.equal(messages.length, 2)
})

// ── resolveEffectiveHistory + /clear + /resume ───────────────────────────────────────

test('resolveEffectiveHistory: after a /clear marker — no summary, only messages after the cut', () => {
  const { d, store, convId, sessionId } = makeCodeConv()
  store.addMessage(convId, 'user', 'old task')
  const oldReply = store.addMessage(convId, 'assistant', 'old reply')
  store.addMessage(convId, 'user', 'new task')

  store.setClearedUpToMessageId(sessionId, oldReply.id)

  const { summaryText, messages } = resolveEffectiveHistory(d, convId, sessionId)
  assert.equal(summaryText, null)
  assert.equal(messages.length, 1)
  assert.equal(messages[0].content, 'new task')
})

test('resolveEffectiveHistory: a /clear after an earlier /compact wins — blank slate, no summary carried forward', () => {
  const { d, store, convId, sessionId } = makeCodeConv()
  store.addMessage(convId, 'user', 'old task 1')
  const oldReply = store.addMessage(convId, 'assistant', 'old reply 1')
  store.addMessage(convId, 'user', 'new task 2')
  const newReply = store.addMessage(convId, 'assistant', 'new reply 2')
  store.addMessage(convId, 'user', 'newest task 3')

  store.updateAgentRun(sessionId, { compactionSummary: 'summary of task 1', compactionUpToMessageId: oldReply.id })
  store.setClearedUpToMessageId(sessionId, newReply.id) // clears everything up through the compacted turn too

  const { summaryText, messages } = resolveEffectiveHistory(d, convId, sessionId)
  assert.equal(summaryText, null)
  assert.equal(messages.length, 1)
  assert.equal(messages[0].content, 'newest task 3')
})

test('resolveEffectiveHistory: /resume (clearing the marker back to null) restores full history, including an earlier compaction', () => {
  const { d, store, convId, sessionId } = makeCodeConv()
  store.addMessage(convId, 'user', 'old task 1')
  const oldReply = store.addMessage(convId, 'assistant', 'old reply 1')
  store.addMessage(convId, 'user', 'new task 2')
  const newReply = store.addMessage(convId, 'assistant', 'new reply 2')

  store.updateAgentRun(sessionId, { compactionSummary: 'summary of task 1', compactionUpToMessageId: oldReply.id })
  store.setClearedUpToMessageId(sessionId, newReply.id)
  store.setClearedUpToMessageId(sessionId, null) // /resume

  const { summaryText, messages } = resolveEffectiveHistory(d, convId, sessionId)
  assert.match(summaryText!, /summary of task 1/)
  assert.equal(messages.length, 2)
  assert.equal(messages[0].content, 'new task 2')
  assert.equal(messages[1].content, 'new reply 2')
})

test('resolveEffectiveHistory: an unresolvable /clear marker (deleted/missing message id) falls through to compaction-only behavior', () => {
  const { d, store, convId, sessionId } = makeCodeConv()
  store.addMessage(convId, 'user', 'task')
  store.addMessage(convId, 'assistant', 'reply')
  store.setClearedUpToMessageId(sessionId, 'does-not-exist')

  const { summaryText, messages } = resolveEffectiveHistory(d, convId, sessionId)
  assert.equal(summaryText, null)
  assert.equal(messages.length, 2)
})

// ── ConversationStore: Code session lifecycle (archive/delete) ───────────────────────

test('setAgentRunArchived: sets and clears archived_at, round trip', () => {
  const { store, sessionId } = makeCodeConv()
  assert.equal(store.getAgentRun(sessionId)!.archivedAt, undefined)

  store.setAgentRunArchived(sessionId, true)
  assert.ok(store.getAgentRun(sessionId)!.archivedAt)

  store.setAgentRunArchived(sessionId, false)
  assert.equal(store.getAgentRun(sessionId)!.archivedAt, undefined)
})

test('deleteCodeSession: removes messages, the run, and the conversation; false for an unknown id', () => {
  const { store, convId, sessionId } = makeCodeConv()
  store.addMessage(convId, 'user', 'task')
  store.addMessage(convId, 'assistant', 'reply')

  assert.equal(store.deleteCodeSession(sessionId), true)
  assert.equal(store.getAgentRun(sessionId), null)
  assert.equal(store.getConversation(convId), null)
  assert.equal(store.getMessages(convId).length, 0)

  assert.equal(store.deleteCodeSession('does-not-exist'), false)
})

// ── compactCodeSession: the clear guard (found by review, not by hand) ───────────────

test('compactCodeSession: rejects with session_cleared when the session has an active /clear marker, before touching the model', async () => {
  const { d, store, convId, sessionId } = makeCodeConv()
  store.addMessage(convId, 'user', 'task')
  const reply = store.addMessage(convId, 'assistant', 'reply')
  store.setClearedUpToMessageId(sessionId, reply.id)

  // No d.manager/d.registry configured on this fake Deps — if the clear guard didn't fire
  // before any model-dependent code, this would throw a DIFFERENT (TypeError) error instead,
  // which would also fail this assertion, but for the wrong reason. Asserting the exact
  // message pins it to the guard specifically.
  await assert.rejects(
    () => compactCodeSession({ d, convId, sessionId, repoRoot: '/repo' }),
    /session_cleared/,
  )
})
