import assert from 'node:assert/strict'
import { test } from 'node:test'
import { SessionAuthRegistry } from './session-auth.js'

test('mint: idempotent — the SAME token is returned for repeated mints of one session', () => {
  const reg = new SessionAuthRegistry()
  const a = reg.mint('session-1')
  const b = reg.mint('session-1')
  assert.equal(a, b)
})

test('mint: two different sessions get two different tokens', () => {
  const reg = new SessionAuthRegistry()
  const a = reg.mint('session-1')
  const b = reg.mint('session-2')
  assert.notEqual(a, b)
})

test('resolve: maps a minted token back to its session id', () => {
  const reg = new SessionAuthRegistry()
  const token = reg.mint('session-1')
  assert.equal(reg.resolve(token), 'session-1')
})

test('resolve: an unrecognized token resolves to null', () => {
  const reg = new SessionAuthRegistry()
  assert.equal(reg.resolve('not-a-real-token'), null)
})

test('revoke: the token no longer resolves, and a later mint issues a NEW token', () => {
  const reg = new SessionAuthRegistry()
  const first = reg.mint('session-1')
  reg.revoke('session-1')
  assert.equal(reg.resolve(first), null)
  const second = reg.mint('session-1')
  assert.notEqual(first, second)
})

test('revoke: safe to call on a session that was never minted', () => {
  const reg = new SessionAuthRegistry()
  assert.doesNotThrow(() => reg.revoke('never-minted'))
})

test('thinking budget: set/get round-trips via a resolved token', () => {
  const reg = new SessionAuthRegistry()
  const token = reg.mint('session-1')
  assert.equal(reg.getThinkingBudgetForToken(token), null, 'no override set yet')
  reg.setThinkingBudget('session-1', 4000)
  assert.equal(reg.getThinkingBudgetForToken(token), 4000)
})

test('thinking budget: null clears a previously-set override', () => {
  const reg = new SessionAuthRegistry()
  const token = reg.mint('session-1')
  reg.setThinkingBudget('session-1', 4000)
  reg.setThinkingBudget('session-1', null)
  assert.equal(reg.getThinkingBudgetForToken(token), null)
})

test('thinking budget: survives a revoke + re-mint (model relaunch) — not tied to the token', () => {
  const reg = new SessionAuthRegistry()
  reg.mint('session-1')
  reg.setThinkingBudget('session-1', 4000)
  reg.revoke('session-1')
  const newToken = reg.mint('session-1')
  assert.equal(reg.getThinkingBudgetForToken(newToken), 4000)
})

test('thinking budget: settable before any token is ever minted for the session', () => {
  const reg = new SessionAuthRegistry()
  reg.setThinkingBudget('session-never-launched', 8000)
  const token = reg.mint('session-never-launched')
  assert.equal(reg.getThinkingBudgetForToken(token), 8000)
})

test('thinking budget: an unrecognized token returns null, never throws', () => {
  const reg = new SessionAuthRegistry()
  assert.equal(reg.getThinkingBudgetForToken('bogus'), null)
})
