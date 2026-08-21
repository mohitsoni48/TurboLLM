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

    // `daysAgo: 1` — the counters describe 08-05, the event is stamped on 08-06.
    const chatEvent = queued.find((q) => q.event === 'chat_daily')
    assert.deepEqual(chatEvent?.payload, { ...chatStats, daysAgo: 1 })
    const codeEvent = queued.find((q) => q.event === 'code_daily')
    assert.deepEqual(codeEvent?.payload, { ...codeStats, daysAgo: 1 })
    // Sorted before comparing: queue file names are `<epoch-ms>-<uuid>.json`, so two events
    // queued within the same millisecond (as these are, emitted back to back in one synchronous
    // loop) tie-break on a random UUID — readQueue's emission order is not guaranteed here.
    const gatewayEvents = queued.filter((q) => q.event === 'gateway_daily')
      .map((q) => q.payload as { protocol: string })
      .sort((a, b) => a.protocol.localeCompare(b.protocol))
    assert.deepEqual(gatewayEvents, [
      { harness: 'unknown', protocol: 'anthropic', requests: 5, promptTokens: 100, genTokens: 50, distinctModels: 1, daysAgo: 1 },
      { harness: 'unknown', protocol: 'openai', requests: 2, promptTokens: 20, genTokens: 10, distinctModels: 1, daysAgo: 1 },
    ])

    // A third call the SAME day must not re-emit — only a real boundary crossing does.
    checkDailyQueryRollups(dir, db, telemetry, () => today)
    assert.equal(readQueue(dir).length, 4, 'no new events queued for a same-day repeat call')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('checkDailyQueryRollups: a day with no chat and no code activity reports NEITHER event', () => {
  const dir = tempDir()
  try {
    const telemetry = makeEmitter(dir)
    // A machine that ran all day but never opened chat or Code. Before the
    // 2026-08-21 audit fix both events were emitted anyway, carrying all-zero
    // payloads: 79% of every code_daily row ever received was this, which is why
    // code_daily and chat_daily were byte-identical and why "98 machines use Code"
    // really meant 18.
    const db = fakeDb(
      { conversations: 0, messages: 0, maxMessagesInConversation: 0, medianMessagesInConversation: 0, distinctModels: 0, toolCalls: 0, regenerates: 0, stops: 0 },
      [],
      { sessions: 0, turns: 0, toolCalls: 0 },
    )

    let today = '2026-08-05'
    checkDailyQueryRollups(dir, db, telemetry, () => today)
    today = '2026-08-06'
    checkDailyQueryRollups(dir, db, telemetry, () => today)

    assert.deepEqual(names(dir), [], 'an idle day must be absent, not reported as a zero')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('checkDailyQueryRollups: chat activity alone reports chat_daily and NOT code_daily', () => {
  const dir = tempDir()
  try {
    const telemetry = makeEmitter(dir)
    // The case that made the two events indistinguishable: someone who chats but has
    // never touched Code must not produce a code_daily at all.
    const db = fakeDb(
      { conversations: 2, messages: 7, maxMessagesInConversation: 4, medianMessagesInConversation: 3, distinctModels: 1, toolCalls: 0, regenerates: 0, stops: 0 },
      [],
      { sessions: 0, turns: 0, toolCalls: 0 },
    )

    let today = '2026-08-05'
    checkDailyQueryRollups(dir, db, telemetry, () => today)
    today = '2026-08-06'
    checkDailyQueryRollups(dir, db, telemetry, () => today)

    assert.deepEqual(names(dir), ['chat_daily'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('checkDailyQueryRollups: daysAgo counts the real gap when the daemon was closed across several midnights', () => {
  const dir = tempDir()
  try {
    const telemetry = makeEmitter(dir)
    const db = fakeDb(
      { conversations: 1, messages: 3, maxMessagesInConversation: 3, medianMessagesInConversation: 3, distinctModels: 1, toolCalls: 0, regenerates: 0, stops: 0 },
      [],
      { sessions: 0, turns: 0, toolCalls: 0 },
    )

    let today = '2026-08-05'
    checkDailyQueryRollups(dir, db, telemetry, () => today) // tracks 08-05
    today = '2026-08-09' // daemon was closed for four days
    checkDailyQueryRollups(dir, db, telemetry, () => today)

    const chat = readQueue(dir)
      .map((q) => q.event as { event: string; payload: { daysAgo: number } })
      .find((q) => q.event === 'chat_daily')
    assert.equal(
      chat?.payload.daysAgo,
      4,
      'the rollup reports the last day it TRACKED, not yesterday — charting it on the event ts would put it on the wrong date',
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('checkDailyQueryRollups: passes through a real classified harness value, and coerces anything not in HARNESSES to unknown', () => {
  const dir = tempDir()
  try {
    const telemetry = makeEmitter(dir)
    const gatewayStats = [
      { protocol: 'anthropic', harness: 'claude_code', requests: 5, promptTokens: 100, genTokens: 50, distinctModels: 1 },
      // A hand-edited DB or a future direct writer producing a value outside HARNESSES must
      // still satisfy PayloadOf<>'s literal-enum type and never reach the Worker unvalidated —
      // this is what the HARNESS_SET membership check in daily-query-rollups.ts guards.
      { protocol: 'openai', harness: 'not-a-real-harness', requests: 1, promptTokens: 5, genTokens: 2, distinctModels: 1 },
    ]
    const db = fakeDb({ conversations: 0 }, gatewayStats, { sessions: 0 })

    let today = '2026-08-05'
    checkDailyQueryRollups(dir, db, telemetry, () => today)
    today = '2026-08-06'
    checkDailyQueryRollups(dir, db, telemetry, () => today)

    const gatewayEvents = readQueue(dir)
      .map((q) => q.event as { event: string; payload: { harness: string; protocol: string } })
      .filter((q) => q.event === 'gateway_daily')
      .map((q) => q.payload)
    assert.deepEqual(
      gatewayEvents.find((p) => p.protocol === 'anthropic'),
      { protocol: 'anthropic', harness: 'claude_code', requests: 5, promptTokens: 100, genTokens: 50, distinctModels: 1, daysAgo: 1 },
    )
    assert.equal(
      gatewayEvents.find((p) => p.protocol === 'openai')?.harness,
      'unknown',
      'an unrecognized harness string must never reach emit() as-is',
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
