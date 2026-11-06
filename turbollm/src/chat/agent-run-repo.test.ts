// AgentRunRepo over a handle it shares with the ConversationStore that owns the schema. The store's
// delegating methods are what the Code and agent runtimes call; these check the class on its own.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ConversationStore, IN_MEMORY_DATA_DIR } from './db'
import { AgentRunRepo } from './agent-run-repo'

function withRepo(fn: (repo: AgentRunRepo, store: ConversationStore) => void): void {
  const store = new ConversationStore(IN_MEMORY_DATA_DIR)
  try { fn(new AgentRunRepo(store.handle), store) } finally { store.close() }
}

function newRun(repo: AgentRunRepo, store: ConversationStore, extra: Partial<Parameters<AgentRunRepo['createAgentRun']>[0]> = {}) {
  const conv = store.createConversation({ kind: 'agent' })
  return repo.createAgentRun({ convId: conv.id, title: 't', allowedTools: ['read'], ...extra })
}

test('a new run is queued, a Code run seeds its diff counters at 0, and updates are visible through the store', () => {
  withRepo((repo, store) => {
    const agent = newRun(repo, store)
    assert.equal(agent.status, 'queued')
    assert.equal(agent.linesAdded, undefined)
    const code = newRun(repo, store, { repoRoot: 'C:/repo' })
    assert.equal(code.linesAdded, 0)
    assert.equal(repo.updateAgentRun(agent.id, { status: 'running' }), true)
    assert.equal(store.getAgentRun(agent.id)?.status, 'running')
  })
})

test('archiving is reversible, and the active and archived lists split on it', () => {
  withRepo((repo, store) => {
    const run = newRun(repo, store)
    repo.setAgentRunArchived(run.id, true)
    assert.deepEqual(repo.listActiveAgentRuns(), [])
    assert.deepEqual(repo.listArchivedAgentRuns().map((r) => r.id), [run.id])
    repo.setAgentRunArchived(run.id, false)
    assert.deepEqual(repo.listActiveAgentRuns().map((r) => r.id), [run.id])
  })
})

test('deleting a Code session removes its run, working doc, messages and conversation', () => {
  withRepo((repo, store) => {
    const run = newRun(repo, store)
    store.addMessage(run.convId, 'user', 'hi')
    repo.upsertRunDoc(run.id, 'notes')
    assert.equal(repo.getRunDoc(run.id), 'notes')
    assert.equal(repo.deleteCodeSession(run.id), true)
    assert.equal(repo.getAgentRun(run.id), null)
    assert.equal(store.getConversation(run.convId), null)
    assert.equal(repo.deleteCodeSession(run.id), false)
  })
})

test('track records count per model and drop with their agent', () => {
  withRepo((repo, store) => {
    const run = newRun(repo, store)
    repo.addTrackRecord({ agentId: 'a', runId: run.id, model: 'm1', outcome: 'complete' })
    repo.addTrackRecord({ agentId: 'a', runId: run.id, model: 'm1', outcome: 'miss' })
    assert.deepEqual(repo.modelStatsForAgent('a'), [{ model: 'm1', total: 2, complete: 1, successRate: 0.5 }])
    repo.pruneTrackRecordForAgent('a')
    assert.deepEqual(repo.trackRecordForAgent('a'), [])
  })
})

test('an agent keeps lessons and skills, finds a skill by name in any case, and loses both when pruned', () => {
  withRepo((repo) => {
    repo.addAgentLesson({ agentId: 'a', lesson: 'check twice' })
    repo.addAgentSkill({ agentId: 'a', name: 'Deploy', procedure: 'steps' })
    assert.equal(repo.listAgentLessons('a').length, 1)
    assert.equal(repo.hasAgentSkillNamed('a', 'deploy'), true)
    assert.equal(repo.countAgentSkills('a'), 1)
    repo.pruneAgentLessons('a')
    repo.pruneAgentSkills('a')
    assert.equal(repo.listAgentLessons('a').length, 0)
    assert.equal(repo.countAgentSkills('a'), 0)
  })
})
