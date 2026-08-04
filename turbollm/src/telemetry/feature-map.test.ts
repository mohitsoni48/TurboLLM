import { test } from 'node:test'
import assert from 'node:assert/strict'
import { featureForPath } from './feature-map'

test('featureForPath: maps each instrumented surface to its feature', () => {
  assert.equal(featureForPath('/api/v1/code/sessions'), 'code')
  assert.equal(featureForPath('/api/v1/artifacts/abc'), 'artifacts')
  assert.equal(featureForPath('/api/v1/mcp/servers'), 'mcp')
  assert.equal(featureForPath('/api/v1/bench/run'), 'autotune')
  assert.equal(featureForPath('/api/v1/comfyui/install'), 'image')
  assert.equal(featureForPath('/api/v1/comfyui/uninstall'), 'image')
})

// PR #105 review finding: real chat traffic (send a message, create/load a
// conversation) lives under /api/v1/conversations/*, not /api/v1/chat/* — the
// latter only covers the Stop-generation button. Both must map to 'chat'.
test('featureForPath: real chat traffic (conversations) maps to chat, not just the Stop button', () => {
  assert.equal(featureForPath('/api/v1/conversations'), 'chat', 'listing conversations')
  assert.equal(featureForPath('/api/v1/conversations/abc123/messages'), 'chat', 'sending a message')
  assert.equal(featureForPath('/api/v1/conversations/abc123/continue'), 'chat', 'continuing a turn')
  assert.equal(featureForPath('/api/v1/chat/stop'), 'chat', 'the Stop button, still mapped')
})

test('featureForPath: research is deliberately NOT mapped — there is no dedicated endpoint', () => {
  // Found in pre-release review: 'research' is a real FEATURES enum value but
  // was silently unmapped, reading as permanent zero adoption. Checked why:
  // web_search is a TOOL invoked inside the chat/agent turn's request BODY —
  // there is no separate /api/v1/research route at all, only /api/v1/chat
  // traffic that may or may not have called the tool. Mapping it here would
  // require inspecting the body, which this module's own doc comment says it
  // never does — so it stays out on purpose, not by oversight.
  assert.equal(featureForPath('/api/v1/research'), null)
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
