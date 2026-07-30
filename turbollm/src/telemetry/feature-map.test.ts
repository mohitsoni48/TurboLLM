import { test } from 'node:test'
import assert from 'node:assert/strict'
import { featureForPath } from './feature-map'

test('featureForPath: maps each instrumented surface to its feature', () => {
  assert.equal(featureForPath('/api/v1/chat/send'), 'chat')
  assert.equal(featureForPath('/api/v1/code/sessions'), 'code')
  assert.equal(featureForPath('/api/v1/artifacts/abc'), 'artifacts')
  assert.equal(featureForPath('/api/v1/mcp/servers'), 'mcp')
  assert.equal(featureForPath('/api/v1/bench/run'), 'autotune')
})

test('featureForPath: uninstrumented routes map to nothing', () => {
  assert.equal(featureForPath('/api/v1/status'), null)
  assert.equal(featureForPath('/api/v1/settings'), null)
  assert.equal(featureForPath('/api/v1/telemetry/preview'), null)
  assert.equal(featureForPath('/'), null)
})

test('featureForPath: skills and chat-agents are deliberately NOT mapped, despite being real features', () => {
  // Found live, running the actual daemon and clicking through the app: the
  // chat compose screen fetches /api/v1/skills and /api/v1/chat-agents
  // UNCONDITIONALLY to populate its persona/agent picker, on every single chat
  // visit — before a user has ever opened Customize -> Skills or Agents, let
  // alone used one. A path-based middleware cannot tell "populating a picker"
  // apart from "the user opened this feature", since both hit the identical
  // endpoint. Mapping these here would mark EVERY user as having discovered
  // Skills and Agents on day one, which is worse than not measuring it at all
  // — it would silently corrupt the exact discovery signal this system exists
  // to produce. Left unmapped until a front-end-driven signal exists (e.g.
  // fired from Customize's own Skills/Agents tab mount, or when a skill/agent
  // is actually invoked in a turn) rather than this blanket path heuristic.
  assert.equal(featureForPath('/api/v1/skills'), null)
  assert.equal(featureForPath('/api/v1/chat-agents'), null)
  assert.equal(featureForPath('/api/v1/chat-agents/123'), null)
})

test('featureForPath: chat-agents is not mistaken for chat', () => {
  // A naive prefix match on "/api/v1/chat" would swallow "/api/v1/chat-agents".
  // It must resolve to null (unmapped), not fall through to 'chat'.
  assert.equal(featureForPath('/api/v1/chat-agents/123'), null)
  assert.notEqual(featureForPath('/api/v1/chat-agents/123'), 'chat')
})

test('featureForPath: a bare segment matches, with or without a trailing slash', () => {
  assert.equal(featureForPath('/api/v1/code'), 'code')
  assert.equal(featureForPath('/api/v1/code/'), 'code')
})

test('featureForPath: a path that merely starts with a feature word does not match', () => {
  assert.equal(featureForPath('/api/v1/codex/thing'), null)
})
