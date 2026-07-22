import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveToolPolicy } from './tool-policy'

test('resolveToolPolicy: default (no policy set) is "ask" when autoAllowAll is off', () => {
  assert.equal(resolveToolPolicy('web_search', {}, {}), 'ask')
  assert.equal(resolveToolPolicy('web_search', {}, {}, false), 'ask')
})

test('resolveToolPolicy: autoAllowAll promotes a default "ask" to "allow"', () => {
  assert.equal(resolveToolPolicy('web_search', {}, {}, true), 'allow')
})

test('resolveToolPolicy: autoAllowAll promotes an explicit global "ask" to "allow"', () => {
  assert.equal(resolveToolPolicy('web_search', { web_search: 'ask' }, {}, true), 'allow')
})

test('resolveToolPolicy: autoAllowAll never overrides an explicit global "deny"', () => {
  assert.equal(resolveToolPolicy('run_code', { run_code: 'deny' }, {}, true), 'deny')
})

test('resolveToolPolicy: autoAllowAll never overrides an explicit per-conversation "deny"', () => {
  assert.equal(resolveToolPolicy('run_code', {}, { run_code: 'deny' }, true), 'deny')
})

test('resolveToolPolicy: autoAllowAll is a no-op when the resolved policy is already "allow"', () => {
  assert.equal(resolveToolPolicy('fetch_url', { fetch_url: 'allow' }, {}, true), 'allow')
})

test('resolveToolPolicy: per-conversation override still wins over the global policy, autoAllowAll off', () => {
  assert.equal(resolveToolPolicy('run_code', { run_code: 'deny' }, { run_code: 'allow' }), 'allow')
})
