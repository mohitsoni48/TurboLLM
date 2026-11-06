import assert from 'node:assert/strict'
import { test } from 'node:test'
import { EventBus } from './bus'

test('keys emitted within one window reach every subscriber once, together', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const bus = new EventBus(150)
  const a: string[][] = []
  const b: string[][] = []
  bus.subscribe((keys) => a.push([...keys]))
  bus.subscribe((keys) => b.push([...keys]))

  bus.emit('conversations')
  bus.emit('conversation:c1')
  bus.emit('conversations')
  assert.deepEqual(a, [], 'nothing is delivered before the window closes')

  t.mock.timers.tick(150)
  assert.deepEqual(a, [['conversations', 'conversation:c1']])
  assert.deepEqual(b, a)
})

test('a burst longer than the window is delivered once per window, not once per emit', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const bus = new EventBus(100)
  let deliveries = 0
  bus.subscribe(() => { deliveries++ })
  for (let ms = 0; ms < 1000; ms += 10) {
    bus.emit('status')
    t.mock.timers.tick(10)
  }
  assert.equal(deliveries, 10)
})

test('with no subscriber, an emit is dropped and schedules nothing', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const bus = new EventBus(100)
  bus.emit('status')
  const seen: string[][] = []
  bus.subscribe((keys) => seen.push([...keys]))
  t.mock.timers.tick(100)
  assert.deepEqual(seen, [])
})

test('an unsubscribed listener hears nothing more, and a throwing one does not stop the others', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const bus = new EventBus(50)
  const seen: string[][] = []
  const off = bus.subscribe(() => { throw new Error('boom') })
  bus.subscribe((keys) => seen.push([...keys]))
  bus.emit('models')
  t.mock.timers.tick(50)
  off()
  assert.equal(bus.subscriberCount(), 1)
  bus.emit('routines')
  t.mock.timers.tick(50)
  assert.deepEqual(seen, [['models'], ['routines']])
})
