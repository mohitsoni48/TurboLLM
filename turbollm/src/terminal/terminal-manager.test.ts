// TerminalManager multi-listener regression tests.
//
// Contract under test: a terminal id can have MORE THAN ONE attached WebSocket listener at
// once (a Code session's terminal opened in two browser tabs) — registering a second listener
// must not silently replace the first, and unregistering one listener must not silence or
// remove any other listener still attached to the same terminal id.
//
// registerWsListener/unregisterWsListener/the private broadcast() fan-out are exercised
// directly rather than through create() — create() spawns a real PTY via node-pty, which is
// unnecessary weight for testing listener bookkeeping. Same "reach into internals via a
// narrow cast" pattern already used by model-router.test.ts for its own private state.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { TerminalManager } from './terminal-manager'

type Handler = { onData?: (data: string) => void; onClose?: () => void }

function privates(m: TerminalManager) {
  return m as unknown as { broadcast(id: string, fn: (h: Handler) => void): void; listeners: Map<string, Set<Handler>> }
}

test('registerWsListener: two listeners on the same id both receive broadcast data', () => {
  const m = new TerminalManager()
  const received1: string[] = []
  const received2: string[] = []
  const h1: Handler = { onData: (d) => received1.push(d) }
  const h2: Handler = { onData: (d) => received2.push(d) }

  m.registerWsListener('term1', h1 as { onData: (data: string) => void })
  m.registerWsListener('term1', h2 as { onData: (data: string) => void })
  privates(m).broadcast('term1', (h) => h.onData?.('hello'))

  assert.deepEqual(received1, ['hello'])
  assert.deepEqual(received2, ['hello'])
})

test('unregisterWsListener: removing one listener does not silence the other', () => {
  const m = new TerminalManager()
  const received1: string[] = []
  const received2: string[] = []
  const h1: Handler = { onData: (d) => received1.push(d) }
  const h2: Handler = { onData: (d) => received2.push(d) }

  m.registerWsListener('term1', h1 as { onData: (data: string) => void })
  m.registerWsListener('term1', h2 as { onData: (data: string) => void })
  m.unregisterWsListener('term1', h1)
  privates(m).broadcast('term1', (h) => h.onData?.('world'))

  assert.deepEqual(received1, [], 'unregistered listener must not receive further broadcasts')
  assert.deepEqual(received2, ['world'], 'the still-attached listener must be untouched')
})

test('unregisterWsListener: a second registration does not overwrite the first (no silent steal)', () => {
  const m = new TerminalManager()
  const received1: string[] = []
  const h1: Handler = { onData: (d) => received1.push(d) }
  const h2: Handler = { onData: () => {} }

  m.registerWsListener('term1', h1 as { onData: (data: string) => void })
  m.registerWsListener('term1', h2 as { onData: (data: string) => void })
  assert.equal(privates(m).listeners.get('term1')?.size, 2)

  privates(m).broadcast('term1', (h) => h.onData?.('still here'))
  assert.deepEqual(received1, ['still here'])
})

test('unregisterWsListener: removing the last listener clears the map entry', () => {
  const m = new TerminalManager()
  const h1: Handler = { onData: () => {} }

  m.registerWsListener('term1', h1 as { onData: (data: string) => void })
  m.unregisterWsListener('term1', h1)

  assert.equal(privates(m).listeners.has('term1'), false)
})

test('unregisterWsListener: unregistering an id with no listeners is a safe no-op', () => {
  const m = new TerminalManager()
  assert.doesNotThrow(() => m.unregisterWsListener('nonexistent', { onData: () => {} }))
})

test('broadcast: onClose fans out to every attached listener', () => {
  const m = new TerminalManager()
  let closed1 = false
  let closed2 = false
  m.registerWsListener('term1', { onData: () => {}, onClose: () => { closed1 = true } })
  m.registerWsListener('term1', { onData: () => {}, onClose: () => { closed2 = true } })

  privates(m).broadcast('term1', (h) => h.onClose?.())

  assert.equal(closed1, true)
  assert.equal(closed2, true)
})
