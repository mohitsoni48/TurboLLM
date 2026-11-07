import assert from 'node:assert/strict'
import { test } from 'node:test'
import { chatRegistries } from './chat-registries'

test('each call gives a fresh ChatTurns and ChatRuns, so one test never inherits another\'s turns', () => {
  const a = chatRegistries()
  const b = chatRegistries()
  assert.notEqual(a.chatTurns, b.chatTurns)
  assert.notEqual(a.chatRuns, b.chatRuns)
  a.chatTurns.claim('c', new AbortController(), 'r')
  assert.deepEqual(b.chatTurns.inFlightChatIds(), [])
})
