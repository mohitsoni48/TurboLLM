import { test } from 'node:test'
import assert from 'node:assert/strict'
import { decideModelAction } from './model-conflict'

test('same model already loaded: run, regardless of idle/busy', () => {
  assert.equal(decideModelAction({ pinnedModel: 'a', currentlyLoaded: 'a', engineIdle: false }), 'run')
  assert.equal(decideModelAction({ pinnedModel: 'a', currentlyLoaded: 'a', engineIdle: true }), 'run')
})

test('different model loaded, engine idle: swap-then-run', () => {
  assert.equal(decideModelAction({ pinnedModel: 'a', currentlyLoaded: 'b', engineIdle: true }), 'swap-then-run')
})

test('different model loaded, engine busy: skip-busy', () => {
  assert.equal(decideModelAction({ pinnedModel: 'a', currentlyLoaded: 'b', engineIdle: false }), 'skip-busy')
})

test('no model loaded at all, engine idle: swap-then-run (nothing to conflict with)', () => {
  assert.equal(decideModelAction({ pinnedModel: 'a', currentlyLoaded: null, engineIdle: true }), 'swap-then-run')
})

test('no model loaded at all, engine busy (e.g. mid-load): skip-busy', () => {
  assert.equal(decideModelAction({ pinnedModel: 'a', currentlyLoaded: null, engineIdle: false }), 'skip-busy')
})
