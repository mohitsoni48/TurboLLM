import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { enqueue, readQueue, MAX_QUEUED_EVENTS } from './queue'

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'turbollm-telemetry-'))
}

function validEvent(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: 1,
    event: 'app_first_run',
    ts: '2026-07-29T12:00:00.000Z',
    machineId: '00000000-0000-0000-0000-000000000000',
    app: { version: '1.9.0', os: 'win32' },
    ...over,
  }
}

test('enqueue: writes a valid event to the queue', () => {
  const dir = tempDir()
  try {
    assert.equal(enqueue(dir, validEvent()), true)
    assert.equal(readQueue(dir).length, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('enqueue: refuses an event the schema rejects, so nothing invalid can ever be queued', () => {
  const dir = tempDir()
  try {
    assert.equal(enqueue(dir, validEvent({ prompt: 'secret' })), false)
    assert.equal(readQueue(dir).length, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('enqueue: the queue is bounded — the oldest events are dropped past the cap', () => {
  const dir = tempDir()
  try {
    for (let i = 0; i < MAX_QUEUED_EVENTS + 25; i++) enqueue(dir, validEvent())
    const queued = readQueue(dir)
    assert.equal(queued.length, MAX_QUEUED_EVENTS)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('enqueue: an unwritable queue directory never throws', () => {
  // A path whose parent is a FILE cannot be created — the realistic
  // "telemetry cannot write" case. It must be swallowed, not surfaced.
  const dir = tempDir()
  try {
    const blocker = join(dir, 'blocker')
    writeFileSync(blocker, 'not a directory')
    assert.equal(enqueue(join(blocker, 'nested'), validEvent()), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('readQueue: a corrupt queue file is skipped, not fatal', () => {
  const dir = tempDir()
  try {
    enqueue(dir, validEvent())
    mkdirSync(join(dir, 'telemetry', 'queue'), { recursive: true })
    writeFileSync(join(dir, 'telemetry', 'queue', 'garbage.json'), '{ not json')
    const queued = readQueue(dir)
    assert.equal(queued.length, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('readQueue: an empty or missing queue reads as empty, not an error', () => {
  const dir = tempDir()
  try {
    assert.deepEqual(readQueue(dir), [])
    assert.deepEqual(readQueue(join(dir, 'nonexistent')), [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('readQueue: entries carry the file name so a drained event can be removed', () => {
  const dir = tempDir()
  try {
    enqueue(dir, validEvent())
    const [entry] = readQueue(dir)
    assert.ok(entry.file.length > 0)
    assert.equal((entry.event as { event: string }).event, 'app_first_run')
    assert.ok(readdirSync(join(dir, 'telemetry', 'queue')).includes(entry.file))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
