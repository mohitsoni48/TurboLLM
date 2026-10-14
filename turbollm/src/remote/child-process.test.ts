import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { ChildTunnel } from './child-process'
import { tmpDir } from '../test-support/tmp'

test('ChildTunnel: a binary that cannot be spawned rejects the start instead of crashing the daemon', async () => {
  // ENOENT on every platform: the cached cloudflared/ngrok was deleted or quarantined after
  // provisioning. Node reports it only as an 'error' event (no 'exit'); unlistened, that event
  // is an uncaught exception that kills this test process — and the daemon.
  const dataDir = tmpDir('child-tunnel-')
  const t = new ChildTunnel(dataDir)
  await assert.rejects(
    t.spawnAndWait(join(dataDir, 'missing-cloudflared'), ['tunnel'], /https:\/\/\S+/, 5_000),
    (e: NodeJS.ErrnoException) => e.code === 'ENOENT',
  )
  assert.equal(t.alive(), false, 'nothing is tracked as running')
  await t.stop() // and a later stop() has nothing to wait for
})
