import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Emitter } from '../emit'
import { readQueue } from '../queue'
import { checkDailyQueryRollups } from './daily-query-rollups'

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'turbollm-daily-query-rollups-'))
}

function makeEmitter(dir: string) {
  const cfg = { telemetry: { level: 'full', machineId: '44444444-4444-4444-4444-444444444444' } }
  const store = { snapshot: () => cfg, update: (fn: (c: typeof cfg) => void) => fn(cfg) }
  return new Emitter({ dataDir: dir, store: store as never, version: '1.11.0', os: 'win32/x64' })
}

function fakeDb(chat: object, gateway: object[], code: object) {
  return {
    chatDailyStats: () => chat,
    gatewayDailyStats: () => gateway,
    codeDailyStats: () => code,
  } as never
}

function names(dir: string): string[] {
  return readQueue(dir).map((q) => (q.event as { event: string }).event)
}

test('checkDailyQueryRollups: the first-ever call on a fresh install reports nothing — there is no real "yesterday" yet', () => {
  const dir = tempDir()
  try {
    const telemetry = makeEmitter(dir)
    checkDailyQueryRollups(dir, fakeDb({ conversations: 1 }, [{ protocol: 'anthropic' }], { sessions: 1 }), telemetry)
    assert.deepEqual(names(dir), [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('checkDailyQueryRollups: a second call on the same day still reports nothing', () => {
  const dir = tempDir()
  try {
    const telemetry = makeEmitter(dir)
    const db = fakeDb({ conversations: 1 }, [], { sessions: 1 })
    checkDailyQueryRollups(dir, db, telemetry)
    checkDailyQueryRollups(dir, db, telemetry)
    assert.deepEqual(names(dir), [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('checkDailyQueryRollups: once the day rolls over, emits chat_daily, code_daily, and one gateway_daily per protocol', () => {
  const dir = tempDir()
  try {
    const telemetry = makeEmitter(dir)
    const chatStats = {
      conversations: 3, messages: 10, maxMessagesInConversation: 5, medianMessagesInConversation: 2,
      distinctModels: 2, toolCalls: 4, regenerates: 1, stops: 0,
    }
    const gatewayStats = [
      { protocol: 'anthropic', requests: 5, promptTokens: 100, genTokens: 50, distinctModels: 1 },
      { protocol: 'openai', requests: 2, promptTokens: 20, genTokens: 10, distinctModels: 1 },
    ]
    const codeStats = { sessions: 1, turns: 4, toolCalls: 6 }
    const db = fakeDb(chatStats, gatewayStats, codeStats)

    let today = '2026-08-05'
    checkDailyQueryRollups(dir, db, telemetry, () => today) // day 1: initializes, nothing queued yet
    assert.deepEqual(names(dir), [])

    today = '2026-08-06' // day rolls over
    checkDailyQueryRollups(dir, db, telemetry, () => today)

    const queued = readQueue(dir).map((q) => q.event as { event: string; payload: unknown })
    const emittedNames = queued.map((q) => q.event).sort()
    assert.deepEqual(emittedNames, ['chat_daily', 'code_daily', 'gateway_daily', 'gateway_daily'].sort())

    const chatEvent = queued.find((q) => q.event === 'chat_daily')
    assert.deepEqual(chatEvent?.payload, chatStats)
    const codeEvent = queued.find((q) => q.event === 'code_daily')
    assert.deepEqual(codeEvent?.payload, codeStats)
    const gatewayEvents = queued.filter((q) => q.event === 'gateway_daily').map((q) => q.payload)
    assert.deepEqual(gatewayEvents, [
      { harness: 'unknown', protocol: 'anthropic', requests: 5, promptTokens: 100, genTokens: 50, distinctModels: 1 },
      { harness: 'unknown', protocol: 'openai', requests: 2, promptTokens: 20, genTokens: 10, distinctModels: 1 },
    ])

    // A third call the SAME day must not re-emit — only a real boundary crossing does.
    checkDailyQueryRollups(dir, db, telemetry, () => today)
    assert.equal(readQueue(dir).length, 4, 'no new events queued for a same-day repeat call')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
