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
import { toSessionStatus, resolveRevertCut } from './code-routes'
import { MUTATING_TOOLS, PATH_TOOLS, resolveEffectiveHistory, compactCodeSession, isDependencyAddCommand, compactionSettingsFor, keepRecentTokensFor, ToolLoopTracker, toolCallSignature, LOOP_BREAK_AFTER, codeEventToFrame, validateDelegateTask, normalizeDelegateResult, DELEGATE_SUBAGENT_TIMEOUT_MS, normalizeTodos, summarizeTodos, MAX_TODOS, type TodoItem } from './code-session'
import { ConversationStore, type Message } from '../chat/db'
import type { Deps } from '../deps'
import type { Skill } from '../agents/skills'
import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent'

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

// ── resolveRevertCut (code-routes.ts) — validation only; the actual hide/show behavior is now
// ConversationStore.deactivateMessagesFrom (below), not a clearedUpToMessageId cut point ---------

function makeRevertConv(): { store: ConversationStore; convId: string } {
  const store = new ConversationStore(mkdtempSync(join(tmpdir(), 'tllm-revert-cut-')))
  const conv = store.createConversation({ kind: 'code' })
  return { store, convId: conv.id }
}

test('resolveRevertCut: a valid target returns its original text', () => {
  const { store, convId } = makeRevertConv()
  store.addMessage(convId, 'user', 'first task')
  store.addMessage(convId, 'assistant', 'first reply')
  const m1 = store.addMessage(convId, 'user', 'second task')
  store.addMessage(convId, 'assistant', 'second reply')

  const messages = store.getConversation(convId, true)!.messages!
  assert.deepEqual(resolveRevertCut(messages, m1.id), { ok: true, revertText: 'second task' })
})

test('resolveRevertCut: reverting to a non-user message is rejected', () => {
  const { store, convId } = makeRevertConv()
  store.addMessage(convId, 'user', 'task')
  const reply = store.addMessage(convId, 'assistant', 'reply')
  const messages = store.getConversation(convId, true)!.messages!
  assert.deepEqual(resolveRevertCut(messages, reply.id), { ok: false, error: 'not_a_user_message' })
})

test('resolveRevertCut: reverting to the FIRST message is rejected (nothing earlier to keep)', () => {
  const { store, convId } = makeRevertConv()
  const first = store.addMessage(convId, 'user', 'first task')
  const messages = store.getConversation(convId, true)!.messages!
  assert.deepEqual(resolveRevertCut(messages, first.id), { ok: false, error: 'no_earlier_message' })
})

test('resolveRevertCut: unknown message id is rejected', () => {
  const { store, convId } = makeRevertConv()
  store.addMessage(convId, 'user', 'task')
  const messages = store.getConversation(convId, true)!.messages!
  assert.deepEqual(resolveRevertCut(messages, 'does-not-exist'), { ok: false, error: 'not_found' })
})

// ── ConversationStore.deactivateMessagesFrom / reactivateMessagesFrom (db.ts) — the real
// revert-to-message mechanism (v33), replacing the clearedUpToMessageId reuse the founder caught
// live-testing against a real 40-message session (AMOLEDBurnFix): reverting to the session's
// actual LAST user message left that message's own reply orphaned and visible with nothing above
// it, since clearedUpToMessageId can only hide a PREFIX and show a SUFFIX — backwards from what a
// revert needs. Real per-message deactivation fixes this generally, for any revert target -------

test('deactivateMessagesFrom: hides the target message AND everything after it, but nothing before', () => {
  const { store, convId } = makeRevertConv()
  store.addMessage(convId, 'user', 'first task')
  store.addMessage(convId, 'assistant', 'first reply')
  const m1 = store.addMessage(convId, 'user', 'second task')
  store.addMessage(convId, 'assistant', 'second reply')

  const affected = store.deactivateMessagesFrom(convId, m1.id)
  assert.equal(affected, 2, 'the reverted message + its own reply')
  const visible = store.getMessages(convId)
  assert.deepEqual(visible.map((m) => m.content), ['first task', 'first reply'], 'everything before the reverted message stays visible; nothing orphaned after it')
})

test('deactivateMessagesFrom: reverting to the actual LAST user message hides its own reply too (the exact reported bug)', () => {
  const { store, convId } = makeRevertConv()
  store.addMessage(convId, 'user', 'go do the thing')
  const lastUser = store.addMessage(convId, 'user', 'delete them no needed')
  store.addMessage(convId, 'assistant', 'Done. The store-assets/ directory has been deleted.')

  store.deactivateMessagesFrom(convId, lastUser.id)
  const visible = store.getMessages(convId)
  assert.deepEqual(visible.map((m) => m.content), ['go do the thing'])
  assert.ok(!visible.some((m) => m.id === lastUser.id))
})

test('deactivateMessagesFrom: reverting to an EARLY message preserves everything before it, unlike a clearedUpToMessageId cut', () => {
  const { store, convId } = makeRevertConv()
  store.addMessage(convId, 'user', 'm0')
  store.addMessage(convId, 'assistant', 'r0')
  const early = store.addMessage(convId, 'user', 'm1') // revert target, well before the end
  store.addMessage(convId, 'assistant', 'r1')
  store.addMessage(convId, 'user', 'm2')
  store.addMessage(convId, 'assistant', 'r2')

  store.deactivateMessagesFrom(convId, early.id)
  assert.deepEqual(store.getMessages(convId).map((m) => m.content), ['m0', 'r0'])
})

test('deactivateMessagesFrom: unknown message id is a no-op (0 rows), never throws', () => {
  const { store, convId } = makeRevertConv()
  store.addMessage(convId, 'user', 'task')
  assert.equal(store.deactivateMessagesFrom(convId, 'does-not-exist'), 0)
  assert.equal(store.getMessages(convId).length, 1, 'untouched')
})

test('reactivateMessagesFrom: undoes deactivateMessagesFrom exactly, restoring full history (the /resume contract)', () => {
  const { store, convId } = makeRevertConv()
  store.addMessage(convId, 'user', 'first task')
  const m1 = store.addMessage(convId, 'user', 'second task')
  store.addMessage(convId, 'assistant', 'second reply')

  store.deactivateMessagesFrom(convId, m1.id)
  assert.equal(store.getMessages(convId).length, 1)
  const restored = store.reactivateMessagesFrom(convId, m1.id)
  assert.equal(restored, 2)
  assert.deepEqual(store.getMessages(convId).map((m) => m.content), ['first task', 'second task', 'second reply'])
})

test('reactivateMessagesFrom: a NEW message sent after a revert is unaffected by a later /resume of that revert', () => {
  const { store, convId } = makeRevertConv()
  store.addMessage(convId, 'user', 'first task')
  const m1 = store.addMessage(convId, 'user', 'second task (attempt 1)')
  store.deactivateMessagesFrom(convId, m1.id)
  // Resend after the revert — appended fresh, same as the real /messages route would do.
  store.addMessage(convId, 'user', 'second task (attempt 2)')
  assert.deepEqual(store.getMessages(convId).map((m) => m.content), ['first task', 'second task (attempt 2)'])

  // Resuming (undoing) the revert brings attempt 1 back WITHOUT disturbing attempt 2.
  store.reactivateMessagesFrom(convId, m1.id)
  assert.deepEqual(store.getMessages(convId).map((m) => m.content), ['first task', 'second task (attempt 1)', 'second task (attempt 2)'])
})

// ── deactivateMessagesUpTo / reactivateMessagesUpTo (db.ts) — the /clear PREFIX deactivation (v34,
// ADR-261). The mirror of deactivateMessagesFrom's suffix: /clear hides everything up to AND
// INCLUDING the cut, so getMessages()/getConversation()/export/model-replay all exclude it at the
// source (is_active=0), replacing the old client-only clearedUpToMessageId display cursor. --------

test('deactivateMessagesUpTo: deactivates the cut message AND everything before it, leaving later turns active', () => {
  const { store, convId } = makeRevertConv()
  store.addMessage(convId, 'user', 'old task')
  const oldReply = store.addMessage(convId, 'assistant', 'old reply')
  store.addMessage(convId, 'user', 'newer, kept turn')

  const affected = store.deactivateMessagesUpTo(convId, oldReply.id)
  assert.equal(affected, 2, 'the two messages at/before the cut')
  assert.deepEqual(store.getMessages(convId).map((m) => m.content), ['newer, kept turn'], 'everything at/before the cut is hidden; the later turn stays')
})

test('deactivateMessagesUpTo: an unknown message id is a no-op (0 rows), never throws', () => {
  const { store, convId } = makeRevertConv()
  store.addMessage(convId, 'user', 'task')
  assert.equal(store.deactivateMessagesUpTo(convId, 'does-not-exist'), 0)
  assert.equal(store.getMessages(convId).length, 1, 'untouched')
})

test('reactivateMessagesUpTo: undoes a /clear exactly, restoring the cleared prefix (the /resume contract)', () => {
  const { store, convId } = makeRevertConv()
  store.addMessage(convId, 'user', 'first')
  const cut = store.addMessage(convId, 'assistant', 'first reply')
  store.deactivateMessagesUpTo(convId, cut.id)
  assert.equal(store.getMessages(convId).length, 0, 'the whole history is cleared')

  const restored = store.reactivateMessagesUpTo(convId, cut.id)
  assert.equal(restored, 2)
  assert.deepEqual(store.getMessages(convId).map((m) => m.content), ['first', 'first reply'])
})

test('reactivateMessagesUpTo: a NEW turn appended AFTER a /clear is unaffected by a later /resume (step-6 case)', () => {
  const { store, convId } = makeRevertConv()
  store.addMessage(convId, 'user', 'A')
  const cut = store.addMessage(convId, 'assistant', 'B') // clear cut here
  store.deactivateMessagesUpTo(convId, cut.id)
  // A brand-new turn after the clear — higher seq than the cut, so it must never be touched by the
  // clear's own resume, and it must remain visible throughout.
  store.addMessage(convId, 'user', 'C (new turn after clear)')
  assert.deepEqual(store.getMessages(convId).map((m) => m.content), ['C (new turn after clear)'])

  // /resume reactivates ONLY the originally-cleared prefix (seq <= cut); the new turn is already
  // active and stays exactly once, not duplicated or disturbed.
  store.reactivateMessagesUpTo(convId, cut.id)
  assert.deepEqual(store.getMessages(convId).map((m) => m.content), ['A', 'B', 'C (new turn after clear)'])
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

// GitHub #60: "ran out of context... it just failed, no attempt to roll up context." pi's own
// auto-compaction defaults (reserve 16384 + keep-recent 20000 = 36384 tokens) assume a large
// hosted model — unscaled, that alone can exceed a typical local model's real context window,
// making compaction self-defeating (it "succeeds" but the result still doesn't fit, and pi only
// retries an overflow once before giving up for good).
test('compactionSettingsFor: scales down for a small local context window (8K)', () => {
  const s = compactionSettingsFor(8192)
  assert.equal(s.enabled, true)
  assert.ok(s.reserveTokens + s.keepRecentTokens < 8192, 'reserve+keepRecent must leave real headroom')
})

test('compactionSettingsFor: reserve+keepRecent stays a bounded fraction of ctx (32K)', () => {
  const s = compactionSettingsFor(32768)
  assert.ok(s.reserveTokens + s.keepRecentTokens <= 32768 * 0.6)
})

test('compactionSettingsFor: never below a sane floor, even for a tiny context', () => {
  const s = compactionSettingsFor(2048)
  assert.ok(s.reserveTokens >= 512)
  assert.ok(s.keepRecentTokens >= 1024)
})

test('compactionSettingsFor: caps at pi\'s own defaults for a large-context local build (200K)', () => {
  const s = compactionSettingsFor(200_000)
  assert.equal(s.reserveTokens, 16384)
  assert.equal(s.keepRecentTokens, 20000)
})

test('compactionSettingsFor: monotonically non-decreasing with contextWindow (below the cap)', () => {
  const small = compactionSettingsFor(8192)
  const big = compactionSettingsFor(65536)
  assert.ok(big.reserveTokens >= small.reserveTokens)
  assert.ok(big.keepRecentTokens >= small.keepRecentTokens)
})

// ── keepRecentTokensFor (code-session.ts) — founder-reported, 2026-07-17 ("I have never yet
// successfully compacted... keeps saying conversation is short"). Root-caused live against a
// real 272K-token AMOLEDBurnFix session: pi's own bundled findCutPoint has a genuine bug where a
// trailing tool-call-only run bigger than keepRecentTokens makes it silently keep EVERYTHING
// instead of falling back to the last real cut point. This guards against it by ensuring
// keepRecentTokens is never smaller than the conversation's own last turn -----------------------

function fakeTurnMsg(role: 'user' | 'assistant', content: string, toolResults: string[] = []): Message {
  return {
    role,
    content,
    toolCalls: toolResults.map((result, i) => ({ id: `tc${i}`, name: 'read', args: {}, result })),
  } as unknown as Message
}

test('keepRecentTokensFor: leaves the base value untouched when the last turn is small', () => {
  const messages = [fakeTurnMsg('user', 'hi'), fakeTurnMsg('assistant', 'hello')]
  assert.equal(keepRecentTokensFor(messages, 20000), 20000)
})

test('keepRecentTokensFor: bumps keepRecentTokens past a large trailing tool-call-only turn', () => {
  const bigResult = 'x'.repeat(40000) // ~10,000 tokens each
  const messages = [
    fakeTurnMsg('user', 'first task'),
    fakeTurnMsg('assistant', 'reply', ['small']),
    fakeTurnMsg('user', 'do something big'),
    fakeTurnMsg('assistant', 'working on it', [bigResult, bigResult]),
  ]
  const bumped = keepRecentTokensFor(messages, 2867) // compactionSettingsFor(8192)'s own value
  assert.ok(bumped > 2867, 'should be bumped above the small base')
  assert.ok(bumped >= Math.ceil((bigResult.length * 2) / 4), "should cover the last turn's real size")
})

test('keepRecentTokensFor: reproduces the exact reported bug scenario and confirms the fix covers it', () => {
  // Mirrors the real AMOLEDBurnFix session that reproduced this: the LAST turn alone (one
  // assistant message + ~30 tool results) summed to ~12K estimated tokens — bigger than
  // compactionSettingsFor's own scaled keepRecentTokens for an 8K or 32K local context (2867 /
  // 11469), which is exactly what made pi's findCutPoint fail every time.
  const toolResults = Array.from({ length: 30 }, () => 'y'.repeat(1600)) // ~12,000 tokens total
  const messages = [
    fakeTurnMsg('user', 'first task'),
    fakeTurnMsg('assistant', 'first reply'),
    fakeTurnMsg('user', 'delete them no needed'),
    fakeTurnMsg('assistant', 'Done.', toolResults),
  ]
  const lastTurnTokens = toolResults.reduce((sum, r) => sum + Math.ceil(r.length / 4), 0)
  assert.ok(lastTurnTokens > 11469, 'sanity: the synthetic last turn must exceed the 32K-ctx scaled threshold to reproduce the bug')
  const bumped = keepRecentTokensFor(messages, 11469)
  assert.ok(bumped > lastTurnTokens, 'bumped keepRecentTokens must exceed the whole last turn, not just be somewhat bigger')
})

test('keepRecentTokensFor: no user message at all returns the base unchanged', () => {
  const messages = [fakeTurnMsg('assistant', 'just a reply, no user turn')]
  assert.equal(keepRecentTokensFor(messages, 5000), 5000)
})

test('keepRecentTokensFor: only counts the LAST turn, not the whole conversation', () => {
  const bigOldResult = 'z'.repeat(400000) // huge, but from an EARLIER turn
  const messages = [
    fakeTurnMsg('user', 'old big task'),
    fakeTurnMsg('assistant', 'huge old reply', [bigOldResult]),
    fakeTurnMsg('user', 'small recent task'),
    fakeTurnMsg('assistant', 'small recent reply'),
  ]
  // The last turn (small recent task + reply) is tiny — the huge earlier turn must NOT inflate it.
  assert.equal(keepRecentTokensFor(messages, 20000), 20000)
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
  // Plan mode has no edit tool, so the edit-reliability, LSP, and todo-tracker blocks are all
  // dropped there (auto/ask get basePersona + mode + edit + lsp + todo = 5).
  assert.equal(plan.length, 2)
  assert.equal(auto.length, 5)
  assert.equal(ask.length, 5)
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
  // basePersona + modeGuidance always; +editReliabilityGuidance +lspGuidance +todoTrackerGuidance
  // outside plan mode (plan has no edit tool, see buildAppendPrompt's own comment); hasWebTools
  // defaults false so the item 1/2 blocks are omitted here (covered separately in persona.test.ts).
  for (const m of ['auto', 'plan', 'ask'] as CodeMode[]) {
    assert.equal(buildAppendPrompt(m).length, m === 'plan' ? 2 : 5)
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

test('resolveEffectiveHistory: after a /clear (v34 — real deactivation) — no summary, only the still-active post-clear messages', () => {
  const { d, store, convId, sessionId } = makeCodeConv()
  store.addMessage(convId, 'user', 'old task')
  const oldReply = store.addMessage(convId, 'assistant', 'old reply')
  store.addMessage(convId, 'user', 'new task')

  // A real /clear now DEACTIVATES the prefix (is_active=0) AND records the marker — mirror both, so
  // getConversation/getMessages already excludes the cleared messages (no cursor slice here anymore).
  store.deactivateMessagesUpTo(convId, oldReply.id)
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
  store.deactivateMessagesUpTo(convId, newReply.id) // /clear deactivates everything through the compacted turn too
  store.setClearedUpToMessageId(sessionId, newReply.id)

  const { summaryText, messages } = resolveEffectiveHistory(d, convId, sessionId)
  assert.equal(summaryText, null) // the earlier compaction summary is behind the clear — dropped
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
  // /clear (deactivate + marker), then /resume (reactivate + null the marker) — the round trip must
  // restore full history AND the earlier compaction summary, exactly as if the clear never happened.
  store.deactivateMessagesUpTo(convId, newReply.id)
  store.setClearedUpToMessageId(sessionId, newReply.id)
  store.reactivateMessagesUpTo(convId, newReply.id)
  store.setClearedUpToMessageId(sessionId, null) // /resume

  const { summaryText, messages } = resolveEffectiveHistory(d, convId, sessionId)
  assert.match(summaryText!, /summary of task 1/)
  assert.equal(messages.length, 2)
  assert.equal(messages[0].content, 'new task 2')
  assert.equal(messages[1].content, 'new reply 2')
})

test('resolveEffectiveHistory: a set /clear marker drops any summary and returns only active messages (blank-slate path)', () => {
  const { d, store, convId, sessionId } = makeCodeConv()
  store.addMessage(convId, 'user', 'task')
  store.addMessage(convId, 'assistant', 'reply')
  // A set clear marker takes the blank-slate branch regardless of the marker resolving to a specific
  // row — the cleared messages are is_active=0 at the source, so `all` is whatever stays active. Here
  // nothing was deactivated (a defensive stale-marker case), so both raw messages remain, no summary.
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

// ── ToolLoopTracker / toolCallSignature — consecutive-identical-call loop breaker ──

test('toolCallSignature: identical calls match regardless of arg key order', () => {
  assert.equal(
    toolCallSignature('edit', { path: 'a.ts', content: 'x' }),
    toolCallSignature('edit', { content: 'x', path: 'a.ts' }),
  )
})

test('toolCallSignature: different tool, args, or nested values do NOT match', () => {
  const base = toolCallSignature('read', { path: 'a.ts' })
  assert.notEqual(base, toolCallSignature('write', { path: 'a.ts' }))       // tool differs
  assert.notEqual(base, toolCallSignature('read', { path: 'b.ts' }))        // arg differs
  assert.notEqual(
    toolCallSignature('bash', { command: 'ls', opts: { cwd: 'a' } }),
    toolCallSignature('bash', { command: 'ls', opts: { cwd: 'b' } }),       // nested differs
  )
})

test('toolCallSignature: undefined / missing / no args are deterministic (identical shapes match)', () => {
  // Loop detection only needs the same call to yield the same signature — these branches must
  // not throw and must be stable so a model repeating a bare/undefined-arg call still trips it.
  assert.equal(toolCallSignature('read', { path: undefined }), toolCallSignature('read', { path: undefined }))
  assert.equal(toolCallSignature('ls', {}), toolCallSignature('ls', {}))
  assert.equal(toolCallSignature('bash', undefined), toolCallSignature('bash', undefined))
})

test('ToolLoopTracker: counts consecutive identical calls; the (LOOP_BREAK_AFTER+1)th trips it', () => {
  const t = new ToolLoopTracker()
  const call = () => t.record('read', { path: 'a.ts' })
  // The first LOOP_BREAK_AFTER calls run normally (count never exceeds the threshold)…
  for (let n = 1; n <= LOOP_BREAK_AFTER; n++) assert.equal(call(), n)
  // …the very next identical call returns a count the hook trips on (record() > LOOP_BREAK_AFTER).
  const trip = call()
  assert.equal(trip, LOOP_BREAK_AFTER + 1)
  assert.ok(trip > LOOP_BREAK_AFTER, 'the (LOOP_BREAK_AFTER+1)th call exceeds the block threshold')
  // It keeps tripping while the model keeps repeating (never silently lets it resume).
  assert.equal(call(), LOOP_BREAK_AFTER + 2)
})

test('ToolLoopTracker: any different call resets the run to 1', () => {
  const t = new ToolLoopTracker()
  t.record('read', { path: 'a.ts' })
  t.record('read', { path: 'a.ts' })
  assert.equal(t.record('read', { path: 'a.ts' }), 3)
  assert.equal(t.record('read', { path: 'b.ts' }), 1)   // different args → reset
  assert.equal(t.record('read', { path: 'b.ts' }), 2)
  assert.equal(t.record('ls', { path: 'b.ts' }), 1)     // different tool → reset
})

test('ToolLoopTracker: reset() clears the count (new top-level turn)', () => {
  const t = new ToolLoopTracker()
  t.record('bash', { command: 'npm test' })
  t.record('bash', { command: 'npm test' })
  t.reset()
  assert.equal(t.record('bash', { command: 'npm test' }), 1)
})

// ── codeEventToFrame (code-session.ts) — pi AgentSessionEvent → SSE frame map (Phase 2, ADR-250).
// The live agentic loop that PRODUCES these events is out of scope here (needs a loaded model),
// same as the rest of this file — but the pure event→frame contract the relay depends on is fully
// testable without one. This is exactly what the relay closure now delegates to. ------------------

// codeEventToFrame only reads a handful of fields per event; a minimal literal cast to the union
// is enough to exercise it without constructing full AgentMessage/ToolResultMessage shapes.
const evt = (e: Record<string, unknown>): AgentSessionEvent => e as unknown as AgentSessionEvent
const freshCounter = () => ({ index: 0 })

test('codeEventToFrame: message_update text_delta → a delta frame (existing behavior preserved)', () => {
  const frame = codeEventToFrame(evt({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'hi' } }), freshCounter())
  assert.deepEqual(frame, { event: 'delta', data: { delta: 'hi' } })
})

test('codeEventToFrame: message_update thinking_delta → a reasoning frame (existing behavior preserved)', () => {
  const frame = codeEventToFrame(evt({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: 'hmm' } }), freshCounter())
  assert.deepEqual(frame, { event: 'reasoning', data: { delta: 'hmm' } })
})

test('codeEventToFrame: a message_update sub-event we do not surface → null (no stray frame)', () => {
  assert.equal(codeEventToFrame(evt({ type: 'message_update', assistantMessageEvent: { type: 'tool_call_delta', delta: 'x' } }), freshCounter()), null)
})

test('codeEventToFrame: compaction_start / compaction_end → compaction frames (existing behavior preserved)', () => {
  assert.deepEqual(
    codeEventToFrame(evt({ type: 'compaction_start', reason: 'threshold' }), freshCounter()),
    { event: 'compaction', data: { phase: 'start', reason: 'threshold' } },
  )
  assert.deepEqual(
    codeEventToFrame(evt({ type: 'compaction_end', reason: 'threshold', aborted: false, result: { tokensBefore: 5000 } }), freshCounter()),
    { event: 'compaction', data: { phase: 'end', reason: 'threshold', aborted: false, tokensBefore: 5000 } },
  )
})

test('codeEventToFrame: turn_start / turn_end → turn frames sharing one index; the counter advances on end', () => {
  const counter = freshCounter()
  assert.deepEqual(codeEventToFrame(evt({ type: 'turn_start' }), counter), { event: 'turn', data: { phase: 'start', index: 0 } })
  assert.equal(counter.index, 0, 'turn_start does not advance the counter')
  assert.deepEqual(codeEventToFrame(evt({ type: 'turn_end', message: {}, toolResults: [{}, {}] }), counter), { event: 'turn', data: { phase: 'end', index: 0, toolResults: 2 } })
  assert.equal(counter.index, 1, 'turn_end advances the counter so the next turn gets a fresh index')
  // The next turn's start/end share index 1 (a start/end pair is always one number).
  assert.deepEqual(codeEventToFrame(evt({ type: 'turn_start' }), counter), { event: 'turn', data: { phase: 'start', index: 1 } })
})

test('codeEventToFrame: auto_retry_start → a retry frame with attempt/max/delay + the error message', () => {
  const frame = codeEventToFrame(evt({ type: 'auto_retry_start', attempt: 2, maxAttempts: 5, delayMs: 1500, errorMessage: 'rate limited' }), freshCounter())
  assert.deepEqual(frame, { event: 'retry', data: { phase: 'start', attempt: 2, maxAttempts: 5, delayMs: 1500, message: 'rate limited' } })
})

test('codeEventToFrame: auto_retry_end → a retry frame carrying success and the final error (if any)', () => {
  assert.deepEqual(
    codeEventToFrame(evt({ type: 'auto_retry_end', success: true, attempt: 3 }), freshCounter()),
    { event: 'retry', data: { phase: 'end', attempt: 3, success: true, message: undefined } },
  )
  assert.deepEqual(
    codeEventToFrame(evt({ type: 'auto_retry_end', success: false, attempt: 5, finalError: 'gave up' }), freshCounter()),
    { event: 'retry', data: { phase: 'end', attempt: 5, success: false, message: 'gave up' } },
  )
})

test('codeEventToFrame: tool_execution_update → a tool_progress frame with the flattened partial text', () => {
  const frame = codeEventToFrame(evt({
    type: 'tool_execution_update', toolCallId: 'tc1', toolName: 'bash',
    args: { command: 'ls' }, partialResult: { content: [{ type: 'text', text: 'line1\n' }, { type: 'text', text: 'line2\n' }], details: undefined },
  }), freshCounter())
  assert.deepEqual(frame, { event: 'tool_progress', data: { id: 'tc1', name: 'bash', partial: 'line1\nline2\n' } })
})

test('codeEventToFrame: tool_execution_update with an empty/odd partialResult yields partial "" (never throws)', () => {
  // The bash tool emits an initial empty snapshot ({ content: [] }); non-text/absent content is
  // defended against since partialResult is typed `any`.
  assert.deepEqual(
    codeEventToFrame(evt({ type: 'tool_execution_update', toolCallId: 't', toolName: 'bash', args: {}, partialResult: { content: [] } }), freshCounter()),
    { event: 'tool_progress', data: { id: 't', name: 'bash', partial: '' } },
  )
  assert.deepEqual(
    codeEventToFrame(evt({ type: 'tool_execution_update', toolCallId: 't', toolName: 'bash', args: {}, partialResult: null }), freshCounter()),
    { event: 'tool_progress', data: { id: 't', name: 'bash', partial: '' } },
  )
})

test('codeEventToFrame: lifecycle events that would DUPLICATE the tool_call pending/done frames are not surfaced', () => {
  // tool_execution_start/_end mirror the pending/done tool_call frames the extension hooks already
  // emit — relaying them too would double-render every call, so they must map to null. Likewise for
  // the message/agent boundary events the relay doesn't use.
  const counter = freshCounter()
  for (const type of ['tool_execution_start', 'tool_execution_end', 'message_start', 'message_end', 'agent_start', 'agent_settled', 'entry_appended']) {
    assert.equal(codeEventToFrame(evt({ type }), counter), null, `${type} must not produce a frame`)
  }
  assert.equal(counter.index, 0, 'unsurfaced events never touch the turn counter')
})

// ── delegate_task pure helpers (code-session.ts) — the subagent/task-delegation tool (ADR-259).
// The live nested sub-session (runDelegatedSubSession, needs a loaded model) is out of scope here,
// same as runSkillSubSession and the rest of this file; its resource-contention correctness rests
// on GenerationGate, which gate.test.ts already proves (single-holder serialization, fg-preempt,
// abort/timeout self-heal). These cover the tool's own pure input/result decision logic. -----------

test('validateDelegateTask: a real task string is accepted and trimmed', () => {
  assert.deepEqual(validateDelegateTask('  investigate the auth flow  '), { ok: true, task: 'investigate the auth flow' })
})

test('validateDelegateTask: empty, whitespace-only, or non-string input is rejected with a usable message', () => {
  for (const bad of ['', '   ', '\n\t', undefined, null, 42, {}]) {
    const r = validateDelegateTask(bad as unknown)
    assert.equal(r.ok, false, `expected rejection for ${JSON.stringify(bad)}`)
    if (!r.ok) assert.match(r.message, /non-empty description/)
  }
})

test('normalizeDelegateResult: a completed sub-agent returns its final text, trimmed', () => {
  assert.equal(normalizeDelegateResult('  the summary of what I did  '), 'the summary of what I did')
})

test('normalizeDelegateResult: an empty completed result becomes an explicit no-output placeholder (never "")', () => {
  assert.equal(normalizeDelegateResult('   '), '(the delegated sub-agent produced no output.)')
})

test('normalizeDelegateResult: a timed-out run is reported as INCOMPLETE and carries any partial text', () => {
  const out = normalizeDelegateResult('got halfway through the refactor', { timedOut: true, timeoutMs: 5 * 60_000 })
  assert.match(out, /did not finish within ~5 minute/)
  assert.match(out, /INCOMPLETE/)
  assert.match(out, /Partial progress before it was stopped:\ngot halfway through the refactor/)
})

test('normalizeDelegateResult: a timed-out run with NO partial output omits the partial section', () => {
  const out = normalizeDelegateResult('', { timedOut: true })
  assert.match(out, /did not finish/)
  assert.doesNotMatch(out, /Partial progress/)
  // Falls back to the module default timeout when timeoutMs is omitted.
  assert.match(out, new RegExp(`~${Math.round(DELEGATE_SUBAGENT_TIMEOUT_MS / 60_000)} minute`))
})

test('DELEGATE_SUBAGENT_TIMEOUT_MS: is a sane positive bound (minutes, not ms typo)', () => {
  assert.ok(DELEGATE_SUBAGENT_TIMEOUT_MS >= 60_000 && DELEGATE_SUBAGENT_TIMEOUT_MS <= 30 * 60_000)
})

// ── update_todos pure helpers (code-session.ts) — the todo/step progress tracker (ADR-255). The
// live tool (registered on a running pi session) is out of scope here, same as the rest of this
// file; these cover the model-facing input coercion + the confirmation summary. --------------------

test('normalizeTodos: passes through a clean list, trimming content and keeping order', () => {
  const raw = [
    { content: '  Add the route  ', status: 'completed' },
    { content: 'Wire the UI', status: 'in_progress' },
    { content: 'Write tests', status: 'pending' },
  ]
  assert.deepEqual(normalizeTodos(raw), [
    { content: 'Add the route', status: 'completed' },
    { content: 'Wire the UI', status: 'in_progress' },
    { content: 'Write tests', status: 'pending' },
  ])
})

test('normalizeTodos: a non-array (or missing) argument is an empty list, never a throw', () => {
  for (const bad of [undefined, null, 'nope', 42, {}]) {
    assert.deepEqual(normalizeTodos(bad as unknown), [])
  }
})

test('normalizeTodos: drops entries with empty/whitespace/non-string content', () => {
  const raw = [
    { content: 'keep me', status: 'pending' },
    { content: '   ', status: 'pending' },
    { content: '', status: 'pending' },
    { content: 123, status: 'pending' },
    { status: 'pending' }, // no content at all
    'not an object',
    null,
  ]
  assert.deepEqual(normalizeTodos(raw), [{ content: 'keep me', status: 'pending' }])
})

test('normalizeTodos: an unknown/missing status defaults to pending (never a bogus status)', () => {
  const raw = [
    { content: 'a', status: 'done' },      // 'done' is not a valid status (it's 'completed')
    { content: 'b' },                       // missing status
    { content: 'c', status: 'in_progress' }, // valid, preserved
  ]
  assert.deepEqual(normalizeTodos(raw), [
    { content: 'a', status: 'pending' },
    { content: 'b', status: 'pending' },
    { content: 'c', status: 'in_progress' },
  ])
})

test('normalizeTodos: caps the list at MAX_TODOS', () => {
  const raw = Array.from({ length: MAX_TODOS + 25 }, (_, i) => ({ content: `step ${i}`, status: 'pending' }))
  const out = normalizeTodos(raw)
  assert.equal(out.length, MAX_TODOS)
  assert.equal(out[0].content, 'step 0')
})

test('summarizeTodos: reports counts of done and in-progress steps', () => {
  const todos: TodoItem[] = [
    { content: 'a', status: 'completed' },
    { content: 'b', status: 'completed' },
    { content: 'c', status: 'in_progress' },
    { content: 'd', status: 'pending' },
  ]
  assert.equal(summarizeTodos(todos), 'Tracking 4 step(s): 2/4 done, 1 in progress.')
})

test('summarizeTodos: omits the in-progress clause when nothing is in progress', () => {
  const todos: TodoItem[] = [{ content: 'a', status: 'completed' }, { content: 'b', status: 'pending' }]
  assert.equal(summarizeTodos(todos), 'Tracking 2 step(s): 1/2 done.')
})

test('summarizeTodos: an empty list reads as an explicit clear', () => {
  assert.equal(summarizeTodos([]), 'Todo list cleared.')
})
