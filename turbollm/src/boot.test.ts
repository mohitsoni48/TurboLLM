// bootDaemon (boot.ts) on a real but inert daemon (test-support/test-daemon.ts): a temp data dir, a free loopback
// port, no engine, no telemetry. These replace source scans of cli.ts, which could not be imported from a test while
// it built the daemon in top-level code.
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { readPidfile } from './daemon-pid'
import { bootTestDaemon } from './test-support/test-daemon'

test('boots on a free loopback port, serves the API, and writes its pidfile in its own data dir', async () => {
  const d = await bootTestDaemon()
  try {
    assert.equal(d.deps.bindHost, '127.0.0.1')
    const res = await fetch(`${d.origin}/api/v1/status`)
    assert.equal(res.status, 200)
    assert.equal(readPidfile(d.dataDir)?.port, d.deps.bindPort)
    assert.ok(existsSync(join(d.dataDir, 'turbollm.db')), 'the chat store lives in the data dir')
  } finally {
    await d.stop()
  }
})

test('close() stops the listener and closes the chat store', async () => {
  const d = await bootTestDaemon()
  await d.stop()
  assert.equal(d.listener().listening, false)
  assert.throws(() => d.deps.db.listConversations(), 'the chat store is closed')
  await assert.rejects(fetch(`${d.origin}/api/v1/status`))
})
