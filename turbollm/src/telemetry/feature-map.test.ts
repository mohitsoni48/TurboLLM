import { test } from 'node:test'
import assert from 'node:assert/strict'
import { featureForPath } from './feature-map'

test('featureForPath: maps each instrumented surface to its feature', () => {
  assert.equal(featureForPath('/api/v1/chat/send'), 'chat')
  assert.equal(featureForPath('/api/v1/code/sessions'), 'code')
  assert.equal(featureForPath('/api/v1/artifacts/abc'), 'artifacts')
  assert.equal(featureForPath('/api/v1/mcp/servers'), 'mcp')
  assert.equal(featureForPath('/api/v1/skills'), 'skills')
  assert.equal(featureForPath('/api/v1/chat-agents'), 'agents')
  assert.equal(featureForPath('/api/v1/bench/run'), 'autotune')
})

test('featureForPath: uninstrumented routes map to nothing', () => {
  assert.equal(featureForPath('/api/v1/status'), null)
  assert.equal(featureForPath('/api/v1/settings'), null)
  assert.equal(featureForPath('/api/v1/telemetry/preview'), null)
  assert.equal(featureForPath('/'), null)
})

test('featureForPath: chat-agents is not mistaken for chat', () => {
  // A naive prefix match on "/api/v1/chat" would swallow "/api/v1/chat-agents"
  // and the agents surface would never be reported as discovered.
  assert.equal(featureForPath('/api/v1/chat-agents/123'), 'agents')
})

test('featureForPath: a bare segment matches, with or without a trailing slash', () => {
  assert.equal(featureForPath('/api/v1/code'), 'code')
  assert.equal(featureForPath('/api/v1/code/'), 'code')
})

test('featureForPath: a path that merely starts with a feature word does not match', () => {
  assert.equal(featureForPath('/api/v1/codex/thing'), null)
})
